import com.healthmarketscience.jackcess.BatchUpdateException;
import com.healthmarketscience.jackcess.Column;
import com.healthmarketscience.jackcess.DataType;
import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.Table;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

/**
 * Fills an existing NetAct dump (.mdb) with rows streamed from Node.js.
 *
 * Protocol (UTF-8, one line per message; "!" is ""; backslash escapes \\t \\n \\r \\\\):
 *   H  <id> <table> <col1> <col2> ...   declare a table's column order
 *   R  <id> <idx>:<value> ...           one sparse row (only present values)
 *   E                                   end of input (flush + close)
 *
 * stderr: "ROWS <n>" progress, "ERR <table> <why>" for skipped rows/values, "DONE <n>" at the end.
 */
public final class MdbFill {
  private static final int BATCH = intEnv("MDB_FILL_BATCH", 500);
  private static final int GLOBAL_BATCH = intEnv("MDB_FILL_GLOBAL_BATCH", 1_000_000);
  private static final String EOF = new String(new char[] {0});
  private static final int READ_QUEUE = 50_000;

  private static int intEnv(String key, int fallback) {
    String raw = System.getenv(key);
    if (raw == null || raw.isBlank()) return fallback;
    try {
      int value = Integer.parseInt(raw.trim());
      return Math.max(1, Math.min(value, 100_000));
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  private static final class ColumnInfo {
    final String name;
    final int position;
    final DataType type;
    final int maxChars;

    ColumnInfo(int position, Column column) {
      this.name = column.getName();
      this.position = position;
      this.type = column.getType();
      this.maxChars = type == DataType.TEXT ? column.getLengthInUnits() : 0;
    }
  }

  private static final class State {
    final String name;
    final Table table;
    final ColumnInfo[] columns;
    final List<Object[]> rows = new ArrayList<>();

    State(String name, Table table, ColumnInfo[] columns) {
      this.name = name;
      this.table = table;
      this.columns = columns;
    }
  }

  private static final class Stats {
    long rows;
    long errors;
    long flushes;
    long addNanos;
    long openNanos;
    long parseNanos;
    long queueNanos;
    long fallbackBatches;
    long fallbackRows;
    final long[] bucketRows = new long[5];
    final long[] bucketFlushes = new long[5];
    final long[] bucketNanos = new long[5];
  }

  public static void main(String[] args) throws Exception {
    if (args.length < 1) {
      System.err.println("usage: MdbFill <database.mdb>");
      System.exit(2);
    }
    File file = new File(args[0]);
    PrintStream out = System.err;
    Stats stats = new Stats();
    State[] states = new State[4096];
    State lastState = null;
    int lastId = -1;
    long buffered = 0;
    long startNanos = System.nanoTime();


    Database db = new DatabaseBuilder(file).setReadOnly(false).setAutoSync(false).open();
    db.setEnforceForeignKeys(false);
    db.setEvaluateExpressions(false);
    BlockingQueue<String> queue = new ArrayBlockingQueue<>(READ_QUEUE);
    final Throwable[] readError = new Throwable[1];
    Thread reader = new Thread(() -> {
      try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8), 1 << 20)) {
        String line;
        while ((line = in.readLine()) != null) queue.put(line);
      } catch (Throwable t) {
        readError[0] = t;
      } finally {
        try {
          queue.put(EOF);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
      }
    }, "stdin-reader");
    reader.setDaemon(true);
    reader.start();
    try {
      while (true) {
        long takeStart = System.nanoTime();
        String line = queue.take();
        stats.queueNanos += System.nanoTime() - takeStart;
        if (line == EOF) break;
        int length = line.length();
        if (length == 0) continue;
        char kind = line.charAt(0);
        if (kind == 'E') break;
        if (kind != 'H' && kind != 'R') continue;

        int idEnd = line.indexOf('\t', 2);
        if (idEnd < 0) continue;
        int id = parseId(line, 2, idEnd);
        if (id <= 0) continue;

        if (kind == 'R' && id == lastId && lastState != null) {
          long parseStart = System.nanoTime();
          Object[] row = parseRow(line, idEnd + 1, lastState, stats, out);
          stats.parseNanos += System.nanoTime() - parseStart;
          if (row == null) continue;
          lastState.rows.add(row);
          buffered++;
          if (lastState.rows.size() >= BATCH) {
            buffered -= lastState.rows.size();
            flush(lastState, stats, out);
          } else if (buffered >= GLOBAL_BATCH) {
            State big = largest(states);
            buffered -= big.rows.size();
            flush(big, stats, out);
          }
          continue;
        }

        if (kind == 'H') {
          int tableEnd = line.indexOf('\t', idEnd + 1);
          String tableName = tableEnd < 0 ? line.substring(idEnd + 1) : line.substring(idEnd + 1, tableEnd);
          if (id >= states.length) states = Arrays.copyOf(states, Math.max(id + 1, states.length * 2));
          if (states[id] != null) continue;
          long openStart = System.nanoTime();
          Table table = db.getTable(tableName);
          List<? extends Column> tableColumns = table.getColumns();
          Map<String, Integer> positions = new java.util.HashMap<>();
          for (int i = 0; i < tableColumns.size(); i++) positions.put(tableColumns.get(i).getName(), i);
          List<String> names = tableEnd < 0 ? List.of() : splitTabs(line, tableEnd + 1);
          List<ColumnInfo> columns = new ArrayList<>(names.size());
          for (String name : names) {
            Integer position = positions.get(name);
            if (position == null) throw new IllegalArgumentException("unknown column " + tableName + "." + name);
            columns.add(new ColumnInfo(position, table.getColumn(name)));
          }
          states[id] = new State(tableName, table, columns.toArray(new ColumnInfo[0]));
          stats.openNanos += System.nanoTime() - openStart;
          continue;
        }

        if (id >= states.length || states[id] == null) continue;
        State state = states[id];
        lastId = id;
        lastState = state;
        long parseStart = System.nanoTime();
        Object[] row = parseRow(line, idEnd + 1, state, stats, out);
        stats.parseNanos += System.nanoTime() - parseStart;
        if (row == null) continue;
        state.rows.add(row);
        buffered++;
        if (state.rows.size() >= BATCH) {
          buffered -= state.rows.size();
          flush(state, stats, out);
        } else if (buffered >= GLOBAL_BATCH) {
          State big = largest(states);
          buffered -= big.rows.size();
          flush(big, stats, out);
        }
      }

      for (State state : states) {
        if (state != null && !state.rows.isEmpty()) flush(state, stats, out);
      }
    } finally {
      db.close();
    }
    if (readError[0] != null) throw new RuntimeException("stdin reader failed", readError[0]);
    out.println(
        "DONE " + stats.rows + " errors=" + stats.errors
            + " flushes=" + stats.flushes
            + " addMs=" + (stats.addNanos / 1_000_000)
            + " openMs=" + (stats.openNanos / 1_000_000)
            + " parseMs=" + (stats.parseNanos / 1_000_000)
            + " queueMs=" + (stats.queueNanos / 1_000_000)
            + " fallbackBatches=" + stats.fallbackBatches
            + " fallbackRows=" + stats.fallbackRows
            + " totalMs=" + ((System.nanoTime() - startNanos) / 1_000_000));
    for (int i = 0; i < stats.bucketFlushes.length; i++) {
      out.println(
          "BUCKET " + i + " flushes=" + stats.bucketFlushes[i] + " rows=" + stats.bucketRows[i]
              + " ms=" + (stats.bucketNanos[i] / 1_000_000));
    }
    out.flush();
  }

  private static State largest(State[] states) {
    State best = null;
    for (State state : states) {
      if (state != null && !state.rows.isEmpty() && (best == null || state.rows.size() > best.rows.size())) best = state;
    }
    return best;
  }

  private static int parseId(String line, int start, int end) {
    if (start >= end) return -1;
    int value = 0;
    for (int i = start; i < end; i++) {
      char c = line.charAt(i);
      if (c < '0' || c > '9') return -1;
      value = value * 10 + (c - '0');
    }
    return value;
  }

  private static List<String> splitTabs(String line, int start) {
    List<String> parts = new ArrayList<>();
    int pos = start;
    int length = line.length();
    while (pos <= length) {
      int tab = line.indexOf('\t', pos);
      if (tab < 0) {
        if (pos < length) parts.add(line.substring(pos));
        break;
      }
      if (tab > pos) parts.add(line.substring(pos, tab));
      pos = tab + 1;
    }
    return parts;
  }

  private static Object[] parseRow(String line, int start, State state, Stats stats, PrintStream out) {
    ColumnInfo[] columns = state.columns;
    Object[] row = new Object[state.table.getColumnCount()];
    boolean any = false;
    int pos = start;
    int length = line.length();

    while (pos < length) {
      int tab = line.indexOf('\t', pos);
      int end = tab < 0 ? length : tab;
      int colon = line.indexOf(':', pos);
      if (colon > pos && colon < end) {
        int index = parseId(line, pos, colon);
        if (index >= 0 && index < columns.length) {
          int valueStart = colon + 1;
          int valueLength = end - valueStart;
          if (valueLength > 0) {
            String value = valueLength == 1 && line.charAt(valueStart) == '!' ? "" : unescape(line.substring(valueStart, end));
            try {
              Object converted = convert(columns[index], value);
              if (converted != null) {
                row[columns[index].position] = converted;
                any = true;
              }
            } catch (RuntimeException e) {
              stats.errors++;
              out.println("ERR " + state.name + " " + columns[index].name + " " + e.getMessage());
            }
          }
        }
      }
      if (tab < 0) break;
      pos = tab + 1;
    }
    return any ? row : null;
  }

  private static String unescape(String raw) {
    int slash = raw.indexOf('\\');
    if (slash < 0) return raw;
    StringBuilder out = new StringBuilder(raw.length());
    out.append(raw, 0, slash);
    for (int i = slash; i < raw.length(); i++) {
      char c = raw.charAt(i);
      if (c != '\\' || i + 1 >= raw.length()) {
        out.append(c);
        continue;
      }
      char next = raw.charAt(++i);
      switch (next) {
        case 't': out.append('\t'); break;
        case 'n': out.append('\n'); break;
        case 'r': out.append('\r'); break;
        default: out.append(next);
      }
    }
    return out.toString();
  }

  private static void flush(State state, Stats stats, PrintStream out) {
    List<Object[]> rows = state.rows;
    int size = rows.size();
    if (size == 0) return;
    long before = stats.rows;
    long flushStart = System.nanoTime();
    int bucket = size < 10 ? 0 : size < 100 ? 1 : size < 1000 ? 2 : size < 10000 ? 3 : 4;
    stats.flushes++;
    stats.bucketFlushes[bucket]++;
    stats.bucketRows[bucket] += size;
    try {
      int from = 0;
      while (from < size) {
        try {
          state.table.addRows(from == 0 ? rows : rows.subList(from, size));
          stats.rows += size - from;
          break;
        } catch (Exception e) {
          if (e instanceof BatchUpdateException) {
            stats.fallbackBatches++;
            int ok = ((BatchUpdateException) e).getUpdateCount();
            if (ok < 0) ok = 0;
            stats.rows += ok;
            from += ok;
            if (from >= size) break;
            stats.errors++;
            stats.fallbackRows++;
            String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage().replace('\n', ' ');
            out.println("ERR " + state.name + " " + why);
            from++;
            continue;
          }
          // A non-batch failure has no useful partial count: retry the remainder row by row.
          stats.fallbackRows += size - from;
          for (int i = from; i < size; i++) {
            try {
              state.table.addRow(rows.get(i));
              stats.rows++;
            } catch (Exception rowError) {
              stats.errors++;
              String why = rowError.getMessage() == null ? rowError.getClass().getSimpleName() : rowError.getMessage().replace('\n', ' ');
              out.println("ERR " + state.name + " " + why);
            }
          }
          break;
        }
      }
    } finally {
      long elapsed = System.nanoTime() - flushStart;
      stats.addNanos += elapsed;
      stats.bucketNanos[bucket] += elapsed;
    }
    rows.clear();
    if (stats.rows - before >= 10_000 || (stats.rows & 0xffff) < size + 1) out.println("ROWS " + stats.rows);
  }

  private static Object convert(ColumnInfo column, String value) {
    if (value.isEmpty()) return null;
    switch (column.type) {
      case BOOLEAN:
        return value.equals("1") || value.equalsIgnoreCase("true") || value.equalsIgnoreCase("yes");
      case BYTE:
        return (byte) Long.parseLong(value);
      case INT:
        return (int) Long.parseLong(value);
      case LONG:
        return Long.parseLong(value);
      case BIG_INT:
        return new BigDecimal(value);
      case FLOAT:
      case DOUBLE:
        return Double.parseDouble(value);
      case NUMERIC:
      case MONEY:
        return new BigDecimal(value);
      case TEXT:
      case MEMO:
        if (column.type == DataType.TEXT && column.maxChars > 0 && value.length() > column.maxChars) {
          return value.substring(0, column.maxChars);
        }
        return value;
      case SHORT_DATE_TIME:
      case EXT_DATE_TIME:
        return parseDate(value);
      default:
        return value;
    }
  }

  private static Object parseDate(String value) {
    try {
      return new java.util.Date(Long.parseLong(value));
    } catch (NumberFormatException ignored) {
      try {
        return java.util.Date.from(OffsetDateTime.parse(value).toInstant());
      } catch (RuntimeException ignored2) {
        LocalDateTime dt = LocalDateTime.parse(value.replace(' ', 'T'));
        return java.util.Date.from(dt.atZone(ZoneId.systemDefault()).toInstant());
      }
    }
  }
}
