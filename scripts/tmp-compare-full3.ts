import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const full = new MDBReader(fs.readFileSync(`${dir}/18-10-2026.mdb`));
const empty = new MDBReader(fs.readFileSync(`${dir}/Dump 4G+5G.mdb`));
const names = full.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });

console.log("A_MRBTS*:", names.filter((n) => n.startsWith("A_MRBTS")));
console.log("A_PLMN*:", names.filter((n) => n.startsWith("A_PLMN")));
console.log("A_OMS*:", names.filter((n) => n.startsWith("A_OMS") || n.startsWith("A_NETACT")));
console.log("~BEAMSET:", names.filter((n) => /BEAMSET|NRBEAM/i.test(n)).slice(0, 12));

const lm = full.getTable("IMPORT_LIST_MAPPING");
const lrows = lm.getData() as Record<string, unknown>[];
for (const list of ["beamSet", "csirsForTracking", "frRefList", "modDNList", "tddFrameStructure", "ulConfiguredGrantType2", "drxProfileNrAnr", "dtxOptimizedScheduler"]) {
  const rows = lrows.filter((r) => r.class === "NRBTS_MRBTS_NRBTS_NRCELL" && r.list === list && r.list_mapping_name === "OSS");
  console.log(`LISTMAP NRCELL.${list}:`, JSON.stringify(rows.map((r) => ({ t: r.mapping_type, c: r.child_class, pre: r.parameter_prefix_list && String(r.parameter_prefix_list).slice(0, 120) }))));
}

const pd = full.getTable("PARAMETER_DECLARATIONS");
const prows = pd.getData() as Record<string, unknown>[];
for (const c of ["NRBTS_NRCELL_ACTCSIRESALLOCOPTLIST", "LTE_SIB_SIBSCHEDULINGLIST", "LTE_LNADJL_BCPLMNIDLIST"]) {
  const rows = prows.filter((r) => r.class === c);
  console.log(`\nPARAMS ${c}:`, JSON.stringify(rows.map((r) => ({ p: r.parameter, t: r.data_type }))));
}

for (const tn of ["A_NRBTS_NRCELL_ACTCSIRESALLOCOPTLIST", "A_LTE_SIB_SIBSCHEDULINGLIST", "A_LTE_MRBTS_LNBTS_LNCEL_LNREL"]) {
  const t = full.getTable(tn);
  console.log(`\n${tn}: full rows=${t.rowCount} empty rows=${empty.getTable(tn).rowCount}`);
  if (tn.endsWith("ACTCSIRESALLOCOPTLIST")) {
    const rows = t.getData({ rowLimit: 5 }) as Record<string, unknown>[];
    console.log(JSON.stringify(rows));
  }
}

for (const c of ["MRBTS", "PLMN", "OMS", "NETACT"]) {
  const tn = `A_${c}`;
  if (names.includes(tn)) {
    const t = full.getTable(tn);
    console.log(`\nA_${c}: full rows=${t.rowCount}, cols=${t.getColumnNames().slice(0, 12).join(",")}`);
  } else console.log(`\nA_${c}: NO TABLE`);
}

const icf = full.getTable("IMPORT_CLASS_FILTER");
const irows = icf.getData() as Record<string, unknown>[];
const mrbts = irows.filter((r) => r.class === "MRBTS");
console.log("\nICF MRBTS:", JSON.stringify(mrbts.map((r) => ({ f: r.class_filter_name, dn: r.raml2_dn_format, ps: r.raml2_dn_parameters }))));
