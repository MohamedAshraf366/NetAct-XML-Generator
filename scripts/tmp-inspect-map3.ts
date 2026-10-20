import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const reader = new MDBReader(fs.readFileSync(`${dir}/Dump 4G+5G.mdb`));

const lm = reader.getTable("IMPORT_LIST_MAPPING");
const lrows = lm.getData() as Record<string, unknown>[];
console.log("list_mapping_name values:", [...new Set(lrows.map((r) => r.list_mapping_name))]);
console.log(
  "plmn list rows:",
  JSON.stringify(lrows.filter((r) => /plmn/i.test(String(r.list))).slice(0, 10))
);
console.log(
  "class LNADJL rows:",
  JSON.stringify(lrows.filter((r) => String(r.class) === "LNADJL").slice(0, 10))
);
console.log(
  "class LNCEL rows:",
  JSON.stringify(lrows.filter((r) => String(r.class) === "LNCEL").slice(0, 20))
);
console.log(
  "class NRCELL rows:",
  JSON.stringify(lrows.filter((r) => String(r.class) === "NRCELL").slice(0, 20))
);

const icf = reader.getTable("IMPORT_CLASS_FILTER");
const irows = icf.getData() as Record<string, unknown>[];
for (const c of ["LNADJL", "LNCEL", "NRCELL", "LNREL", "MRBTS"]) {
  const r = irows.filter((x) => String(x.class) === c);
  console.log(`\nCLASS_FILTER ${c}:`, JSON.stringify(r.map((x) => ({ f: x.class_filter_name, dn: x.raml2_dn_format, ps: x.raml2_dn_parameters }))));
}

console.log("\nfilter names:", [...new Set(irows.map((r) => r.class_filter_name))]);
console.log("icf class count:", new Set(irows.map((r) => r.class)).size);

const cd = reader.getTable("CLASS_DECLARATION");
const crows = cd.getData() as Record<string, unknown>[];
console.log(
  "CLASS_DECLARATION classes sample:",
  crows.map((r) => r.class).filter((c) => String(c).includes("LNADJL") || String(c).includes("PLMN")).slice(0, 20)
);
console.log("cd class count:", crows.length, new Set(crows.map((r) => r.class)).size);
