# mdb-fill (Jackcess helper)

`MdbFill.java` is the small writer process used by `/fill` (`src/lib/fill.ts`). It reads a simple tab-separated
protocol from stdin and inserts rows into the Access dump with [Jackcess](https://jackcess.sourceforge.io/):

```
H<TAB>id<TAB>table<TAB>col1<TAB>col2...    declare the column order once per table
R<TAB>id<TAB>idx:value<TAB>idx:value...   one row; "idx" is the column index
E                                        end of input
```

Values are raw UTF-8. Tabs, newlines, carriage returns and backslashes are escaped with a backslash; `!` means an empty
string and a literal `!` is sent as `\!`. Columns without a value are omitted. Progress and per-value errors are
written to stderr (`ROWS ...`, `ERR <table> <reason>`, `DONE`, plus optional timing counters).

## Build

Java 17+ (a JDK, not just a JRE):

```bash
javac -cp jackcess-5.0.4.jar -d classes MdbFill.java
```

The Docker image compiles this during the build and ships only a JRE plus `classes/`.

## Usage

```bash
java -Xmx448m -Duser.timezone=UTC -cp "classes;jackcess-5.0.4.jar" MdbFill path/to/dump.mdb
```

Use `:` instead of `;` on Linux/macOS. `src/lib/fill.ts` passes the heap, classpath and UTC timezone itself, and
finds Java through `MDB_FILL_JAVA`, `JAVA_HOME`, a portable `tools/jre`, common install locations, or `PATH`. Set
`MDB_FILL_CLASSES` / `MDB_FILL_JAR` only when the defaults do not fit. The writer heap defaults to `-Xmx1g`.

## Third-party

`jackcess-5.0.4.jar` is Jackcess 5.0.4, licensed under the Apache License 2.0 (see the `LICENSE`/`NOTICE` files in the
Jackcess distribution).
