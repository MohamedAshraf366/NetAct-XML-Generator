import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const full = new MDBReader(fs.readFileSync(`${dir}/18-10-2026.mdb`));
const empty = new MDBReader(fs.readFileSync(`${dir}/Dump 4G+5G.mdb`));

const names = full.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
console.log("tables starting A_MRBTS:", names.filter((n) => n.startsWith("A_MRBTS")));
console.log("tables starting A_PLMN:", names.filter((n) => n.startsWith("A_PLMN")));
console.log("tables ~SIBSCHED:", names.filter((n) => /SIBSCHED/i.test(n)));
console.log("tables ~MOPRMAPPING:", names.filter((n) => /MOPRMAPPING/i.test(n)));
console.log("tables ~CELLBWP:", names.filter((n) => /CELLBWP/i.test(n)));

const pick = (row: Record<string, unknown>, cols: string[]) => Object.fromEntries(cols.map((c) => [c, row[c]]));
const num = (v: unknown) => Number(v);

{
  const t = full.getTable("A_NRBTS_MRBTS_NRBTS_NRCELL");
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => num(r.mrbtsId) === 10000 && num(r.nrBtsId) === 10000 && num(r.nrCellId) === 10);
  console.log("\nNRCELL rows for 10000/10000/10:", hit.length);
  for (const r of hit)
    console.log(
      "NRCELL:",
      JSON.stringify(
        pick(r, [
          "mrbtsId", "nrBtsId", "nrCellId", "name", "angle", "mcc", "mnc", "status", "last_modified", "last_actual_import",
          "dlCqiRestriction_additionalCqiIncrRankRedn", "dlCqiRestriction_allowedCqiIncrement",
          "dlPtrs_actDlPtrs", "dlPtrs_dlPtrsFreqDensityThresNrb0",
          "a4PeriodicMeasControlSA_a4Fr1SupervisionTimer", "a4PeriodicMeasControlSA_a4MeasMaxNumber",
        ])
      )
    );
}

for (const tn of names.filter((n) => /MOPRMAPPING|CELLBWP/i.test(n)).slice(0, 4)) {
  const t = full.getTable(tn);
  console.log(`\n${tn}: ${t.rowCount} rows, cols: ${t.getColumnNames().slice(0, 14).join(",")}`);
  const rows = t.getData({ rowLimit: 2 }) as Record<string, unknown>[];
  console.log("sample:", JSON.stringify(rows));
}

for (const tn of names.filter((n) => /SIBSCHED/i.test(n))) {
  const t = full.getTable(tn);
  console.log(`\n${tn}: ${t.rowCount} rows, cols: ${t.getColumnNames().join(",")}`);
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => num(r.mrbtsId) === 28942 && num(r.lnBtsId) === 28942 && num(r.lnCelId) === 1);
  console.log("rows for parent:", hit.length, JSON.stringify(hit.slice(0, 4)));
}

const lm = full.getTable("IMPORT_LIST_MAPPING");
const lrows = lm.getData() as Record<string, unknown>[];
for (const [cls, list] of [
  ["LTE_MRBTS_LNBTS_LNCEL_SIB", "sibSchedulingList"],
  ["NRBTS_MRBTS_NRBTS_NRCELL", "dlPtrs"],
  ["NRBTS_MRBTS_NRBTS_NRCELL", "dlCqiRestriction"],
  ["NRBTS_MRBTS_NRBTS_NRCELL", "actCsiResAllocOptList"],
  ["NRBTS_MRBTS_NRBTS_NRCELL", "a4PeriodicMeasControlSA"],
  ["LTE_MRBTS_LNBTS_LNCEL", "moPrMappingList"],
]) {
  const rows = lrows.filter((r) => r.class === cls && r.list === list);
  console.log(`\nLISTMAP ${cls}.${list}:`, JSON.stringify(rows.map((r) => ({ n: r.list_mapping_name, t: r.mapping_type, c: r.child_class, pre: r.parameter_prefix_list, pmin: r.parameter_postfix_min, pmax: r.parameter_postfix_max, nd: r.not_defined_list, st: r.structure }))));
}

const cd = full.getTable("CLASS_DECLARATION");
const crows = cd.getData() as Record<string, unknown>[];
for (const c of ["LTE_LNADJL_BCPLMNIDLIST", "LTE_SIB_SIBSCHEDULINGLIST", "NRBTS_NRCELL_CELLBWPLIST", "LTE_LNCEL_MOPRMAPPINGLIST", "LTE_MRBTS_LNBTS_LNCEL_SIB"]) {
  const r = crows.filter((x) => x.class === c);
  console.log(`\nCD ${c}:`, JSON.stringify(r.map((x) => ({ p: x.parent_class, pk: x.parent_class_id_field, k: x.default_key_name }))));
}

const icf = full.getTable("IMPORT_CLASS_FILTER");
const irows = icf.getData() as Record<string, unknown>[];
for (const c of ["LTE_MRBTS_LNBTS_LNCEL_SIB", "NRBTS_MRBTS_NRBTS_NRCELL", "LTE_MRBTS_LNBTS_LNADJ_LNADJL", "PLMN", "OMS"]) {
  const r = irows.filter((x) => x.class === c && (x.class_filter_name === "OSS" || x.class_filter_name === "Generic"));
  console.log(`\nICF ${c}:`, JSON.stringify(r.map((x) => ({ f: x.class_filter_name, dn: x.raml2_dn_format, ps: x.raml2_dn_parameters }))));
}
