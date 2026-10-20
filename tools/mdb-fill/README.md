# mdb-fill (Jackcess helper)

`MdbFill.java` is the small writer process used by `/fill` (`src/lib/fill.ts`). It reads a simple tab-separated
protocol from stdin and inserts rows into the Access dump with [Jackcess](https://jackcess.sourceforge.io/):

```
H<TAB>table<TAB>col1<TAB>col2...   declare the column order once per table
R<TAB>table<TAB>value1<TAB>value2  base64 value, "-" for null, "!" for an empty string
E                                  end of input
```

Progress and per-value errors are written to stderr (`ROWS ...`, `ERR <table> <reason>`, `DONE`).

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
`MDB_FILL_CLASSES` / `MDB_FILL_JAR` only when the defaults do not fit.

## Third-party

`jackcess-5.0.4.jar` is Jackcess 5.0.4, licensed under the Apache License 2.0 (see the `LICENSE`/`NOTICE` files in the
Jackcess distribution).
