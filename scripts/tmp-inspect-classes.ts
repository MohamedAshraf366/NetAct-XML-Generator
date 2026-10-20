import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const reader = new MDBReader(fs.readFileSync(`${dir}/Dump 4G+5G.mdb`));
for (const n of ["CLASS_DECLARATION", "PARAMETER_DECLARATIONS", "IMPORT_CLASS_FILTER", "TOPOLOGY_VIEW"]) {
  const t = reader.getTable(n);
  const rows = t.getData({ rowLimit: 3 }) as Record<string, unknown>[];
  console.log(`\n=== ${n} (${t.rowCount}) ===`);
  console.log("cols:", t.getColumnNames().join(", "));
  for (const r of rows) console.log(JSON.stringify(r));
}
