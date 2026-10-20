import fs from "node:fs";
import MDB from "mdb-reader";

const db = new MDB(fs.readFileSync("C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/Dump 4G+5G.mdb"));
const icf = db.getTable("IMPORT_CLASS_FILTER").getData() as Record<string, unknown>[];
const pf = db.getTable("IMPORT_PARAMETER_FILTER").getData() as Record<string, unknown>[];
for (const cls of ["NRBTS_NRCELL_SCH", "LTE_LNCEL_DC", "NRBTS_NRCELL_DRXPROFILENRANR"]) {
  console.log("== ICF", cls);
  for (const x of icf.filter((r) => String(r.class) === cls)) console.log("  ", x.class_filter_name, "|", x.raml2_dn_format, "|", x.raml2_dn_parameters);
  const rows = pf.filter((r) => String(r.class) === cls && String(r.parameter_filter_name) === "OSS");
  console.log("== PF OSS", cls, "count", rows.length);
  for (const r of rows.slice(0, 30)) console.log("  ", r.parameter, "| ext", r.external_name, "| map", r.mapping_name, "| list", r.list_name);
}
