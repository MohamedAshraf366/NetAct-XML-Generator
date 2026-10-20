import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const reader = new MDBReader(fs.readFileSync(`${dir}/Dump 4G+5G.mdb`));
for (const n of ["IMPORT_LIST_MAPPING", "EXPORT_LIST_MAPPING", "PARAMETER_VALUE_MAPPING"]) {
  const t = reader.getTable(n);
  const rows = t.getData({ rowLimit: 6 }) as Record<string, unknown>[];
  console.log(`\n=== ${n} (${t.rowCount}) ===`);
  console.log("cols:", t.getColumnNames().join(", "));
  for (const r of rows) console.log(JSON.stringify(r));
}
