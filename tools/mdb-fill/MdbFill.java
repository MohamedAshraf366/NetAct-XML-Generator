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
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Fills an existing NetAct dump (.mdb) with rows streamed from Node.js.
 *
 * Protocol (UTF-8, one line per message, values are Base64 or "-" for null, "!" for ""):
 *   H  <table> <col1> <col2> ...   declare a table's column order
 *   R  <table> <v1> <v2> ...       one row for that table
 *   E                              end of input (flush + close)
 *
 * stderr: "ROWS <n>" progress, "ERR <table> <why>" for skipped rows/values, "DONE <n>" at the end.
 */
public final class MdbFill {
  private static final int BATCH = 1000;
  private static final int GLOBAL_BATCH = 30_000;

  private static final class State {
    final Table table;
    final List<Column> cols;
    final List<Map<String, Object>> rows = new ArrayList<>();

    State(Table table, List<Column> cols) {
      this.table = table;
      this.cols = cols;
    }
  }

  private static final class Stats {
    long rows;
    long errors;
  }

  public static void main(String[] args) throws Exception {
    if (args.length < 1) {
      System.err.println("usage: MdbFill <database.mdb>");
      System.exit(2);
    }
    File file = new File(args[0]);
    PrintStream out = System.err;
    Stats stats = new Stats();
    Map<String, State> states = new HashMap<>();
    long buffered = 0;

    Database db = new DatabaseBuilder(file).setReadOnly(false).setAutoSync(false).open();
    try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8), 1 << 20)) {
      String line;
      while ((line = in.readLine()) != null) {
        if (line.isEmpty()) continue;
        char kind = line.charAt(0);
        if (kind == 'E') break;
        if (kind != 'H' && kind != 'R') continue;

        String[] parts = line.split("\t", -1);
        if (kind == 'H') {
          if (parts.length < 3) continue;
          State state = states.get(parts[1]);
          List<String> names = new ArrayList<>(parts.length - 2);
          for (int i = 2; i < parts.length; i++) if (!parts[i].isEmpty()) names.add(parts[i]);
          if (state != null) {
            boolean same = state.cols.size() == names.size();
            for (int i = 0; same && i < names.size(); i++) same = state.cols.get(i).getName().equals(names.get(i));
            if (!same) {
              buffered -= state.rows.size();
              flush(state, stats, out);
            }
            continue;
          }
          Table table = db.getTable(parts[1]);
          List<Column> cols = new ArrayList<>(names.size());
          for (String n : names) cols.add(table.getColumn(n));
          states.put(parts[1], new State(table, cols));
          continue;
        }

        // R <table> <v1> ...
        State state = states.get(parts[1]);
        if (state == null) continue;
        Map<String, Object> row = new LinkedHashMap<>(state.cols.size() * 2);
        for (int i = 0; i < state.cols.size(); i++) {
          String raw = i + 2 < parts.length ? parts[i + 2] : "-";
          if (raw.isEmpty() || raw.equals("-")) continue;
          String value = raw.charAt(0) == '!' ? "" : new String(Base64.getDecoder().decode(raw), StandardCharsets.UTF_8);
          Column col = state.cols.get(i);
          try {
            Object converted = convert(col, value);
            if (converted != null) row.put(col.getName(), converted);
          } catch (RuntimeException e) {
            stats.errors++;
            out.println("ERR " + parts[1] + " " + col.getName() + " " + e.getMessage());
          }
        }
        if (row.isEmpty()) continue;
        state.rows.add(row);
        buffered++;
        if (state.rows.size() >= BATCH || buffered >= GLOBAL_BATCH) {
          buffered -= state.rows.size();
          flush(state, stats, out);
        }
      }

      for (State state : states.values()) {
        if (!state.rows.isEmpty()) {
          buffered -= state.rows.size();
          flush(state, stats, out);
        }
      }
    } finally {
      db.close();
    }
    out.println("DONE " + stats.rows + " errors=" + stats.errors);
    out.flush();
  }

  private static void flush(State state, Stats stats, PrintStream out) {
    List<Map<String, Object>> rows = state.rows;
    if (rows.isEmpty()) return;
    for (Map<String, Object> row : rows) {
      try {
        state.table.addRowFromMap(row);
        stats.rows++;
      } catch (Exception e) {
        stats.errors++;
        String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage().replace('\n', ' ');
        out.println("ERR " + state.table.getName() + " " + why);
      }
    }
    rows.clear();
    if ((stats.rows & 0xffff) < rows.size() + 1) out.println("ROWS " + stats.rows);
  }

  private static Object convert(Column column, String value) {
    if (value.isEmpty()) return null;
    DataType type = column.getType();
    switch (type) {
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
      case MEMO: {
        int len = column.getLengthInUnits();
        if (type == DataType.TEXT && len > 0 && value.length() > len) return value.substring(0, len);
        return value;
      }
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
