import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const reader = new MDBReader(fs.readFileSync(`${dir}/Dump 4G+5G.mdb`));

const names = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
for (const pat of [/^A_LTE_LNADJL/, /^A_NRBTS_NRCELL/, /^A_LTE_MRBTS_LNBTS_LNCEL_/, /^A_LTE_MRBTS_LNBTS_LNADJ_/]) {
  console.log(`\n### ${pat}`);
  for (const n of names.filter((n) => pat.test(n))) console.log(" ", n);
}

const lm = reader.getTable("IMPORT_LIST_MAPPING");
const map = lm.getData() as Record<string, unknown>[];
for (const key of [
  ["LNADJL", "bcPlmnIdList"],
  ["NRCELL", "cellBwpList"],
  ["NRCELL", "beamSet"],
  ["LNCEL", "moPrMappingList"],
  ["LNADJ", "guGroupIdList"],
]) {
  const r = map.filter((x) => x.class === key[0] && x.list === key[1]);
  console.log(`\n${key[0]}.${key[1]}:`, JSON.stringify(r));
}

const cd = reader.getTable("CLASS_DECLARATION");
const classes = cd.getData() as Record<string, unknown>[];
for (const c of ["LNADJL", "BCPLMNIDLIST", "LNADJL_BCPLMNIDLIST", "CELLBWPLIST", "NRCELL_CELLBWPLIST", "BWSET", "BEAMSET"]) {
  const r = classes.filter((x) => x.class === c);
  console.log(`class ${c}:`, JSON.stringify(r));
}

for (const tn of ["A_LTE_LNADJL_BCPLMNIDLIST", "A_LTE_MRBTS_LNBTS_LNADJ_LNADJL"]) {
  if (!names.includes(tn)) continue;
  const t = reader.getTable(tn);
  console.log(`\n${tn}: ${t.rowCount} rows`);
  console.log("cols:", t.getColumnNames().join(", "));
}
