import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const reader = new MDBReader(fs.readFileSync(`${dir}/Dump 4G+5G.mdb`));

const lm = reader.getTable("IMPORT_LIST_MAPPING");
const lrows = lm.getData() as Record<string, unknown>[];
for (const q of ["LNADJL", "LNCEL", "NRCELL"]) {
  const rows = lrows.filter((r) => String(r.class).toUpperCase().includes(q));
  console.log(`\nLISTMAP class~${q}: ${rows.length}`);
  console.log(JSON.stringify(rows.slice(0, 12)));
}
const bc = lrows.filter((r) => /bcplmn/i.test(String(r.list)));
console.log("\nLISTMAP list~bcplmn:", bc.length, JSON.stringify(bc.slice(0, 12)));

const icf = reader.getTable("IMPORT_CLASS_FILTER");
const irows = icf.getData() as Record<string, unknown>[];
for (const q of ["LNADJL", "LNCEL", "NRCELL", "LNREL"]) {
  const rows = irows.filter((r) => String(r.class).toUpperCase().includes(q));
  console.log(`\nICF class~${q}: ${rows.length}`);
  console.log(JSON.stringify(rows.slice(0, 10).map((x) => ({ c: x.class, f: x.class_filter_name, dn: x.raml2_dn_format }))));
}

const cd = reader.getTable("CLASS_DECLARATION");
const crows = cd.getData() as Record<string, unknown>[];
const lnc = crows.filter((r) => String(r.class).includes("LNCEL")).slice(0, 12);
console.log("\nCD class~LNCEL sample:", JSON.stringify(lnc.map((x) => ({ c: x.class, p: x.parent_class, pk: x.parent_class_id_field }))));
const rel = crows.filter((r) => String(r.class).includes("LNREL")).slice(0, 12);
console.log("CD class~LNREL sample:", JSON.stringify(rel.map((x) => ({ c: x.class, p: x.parent_class, pk: x.parent_class_id_field }))));
