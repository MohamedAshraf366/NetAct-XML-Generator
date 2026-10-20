import fs from "node:fs";
import MDB from "mdb-reader";

const db = new MDB(fs.readFileSync("C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/Dump 4G+5G.mdb"));
const rows = db.getTable("IMPORT_PARAMETER_FILTER").getData() as Record<string, unknown>[];
for (const cls of ["LTE_MRBTS_LNBTS_LNCEL_DRX", "NRBTS_NRCELL_SCH", "NRBTS_NRCELL_DRXPROFILENRANR"]) {
  console.log("==", cls);
  const list = rows.filter((r) => String(r.class) === cls);
  console.log("count", list.length);
  for (const r of list.slice(0, 80)) console.log("  ", r.parameter_filter_name, "|", r.parameter, "|", r.mandatory, "| ext", r.external_name, "| map", r.mapping_name, "| list", r.list_name);
}
console.log("== rows where parameter like drxProfile101%");
for (const r of rows.filter((r) => /drxProfile101/i.test(String(r.parameter))).slice(0, 20)) console.log("  ", JSON.stringify(r));
