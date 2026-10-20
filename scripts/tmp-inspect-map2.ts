import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const reader = new MDBReader(fs.readFileSync(`${dir}/Dump 4G+5G.mdb`));

for (const tn of ["CLASS_DECLARATION", "IMPORT_LIST_MAPPING", "IMPORT_CLASS_FILTER", "PARAMETER_DECLARATIONS"]) {
  const t = reader.getTable(tn);
  console.log(`\n### ${tn}: ${t.rowCount} rows, cols: ${t.getColumnNames().join(", ")}`);
  const rows = t.getData({ rowLimit: 3 }) as Record<string, unknown>[];
  console.log(JSON.stringify(rows, null, 1).slice(0, 2500));
}

const lm = reader.getTable("IMPORT_LIST_MAPPING");
const lrows = lm.getData() as Record<string, unknown>[];
const classes = [...new Set(lrows.map((r) => r.class))];
console.log("\nIMPORT_LIST_MAPPING classes:", classes.length, classes.slice(0, 30));
const hits = lrows.filter((r) => String(r.list).toLowerCase().includes("bcplmn"));
console.log("bcplmn rows:", JSON.stringify(hits.slice(0, 5)));

const cd = reader.getTable("CLASS_DECLARATION");
const crows = cd.getData() as Record<string, unknown>[];
console.log("\nCLASS_DECLARATION sample classes:", crows.slice(0, 10).map((r) => r.class));
const chits = crows.filter((r) => String(r.class).toLowerCase().includes("lnadjl"));
console.log("lnadjl class rows:", JSON.stringify(chits.slice(0, 5)));

const icf = reader.getTable("IMPORT_CLASS_FILTER");
const irows = icf.getData() as Record<string, unknown>[];
const ihits = irows.filter((r) => String(r.class).toLowerCase().includes("lnadjl"));
console.log("\nIMPORT_CLASS_FILTER lnadjl rows:", JSON.stringify(ihits.slice(0, 5), null, 1).slice(0, 3000));
