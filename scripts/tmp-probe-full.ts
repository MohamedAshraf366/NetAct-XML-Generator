import fs from "node:fs";
import MDB from "mdb-reader";

const path = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/18-10-2026.mdb";
const db = new MDB(fs.readFileSync(path));
const names = db.getTableNames();

console.log("tables:", names.length);

const checks = [
  ["A_LTE_MRBTS_LNBTS_LNCEL_LNCEL_FDD", ["assignedRaPreGrASize", "assignedNumSkipRootSeq", "actDlMutedCell", "actOptRootSeq", "assignedRaNondedPreamb"]],
  ["A_NRBTS_MRBTS_NRBTS_NRDRB", ["actDpiGoodput", "actDpiRtt", "actRlcUmSegSnMgmt", "allowedPdcchPowerBoostALDueCce", "allowedPdcchPowerBoostALDueCfg", "maxForwardTimeLimitXx", "minForwardTputXx"]],
  ["A_LTE_MRBTS_LNBTS_LNCEL", ["act4TxFailHandling", "actB1ThresholdsReturnTo5GSA", "actIncCarrFor3GPPnonComplUes", "actNrServBasedHoQciX"]],
  ["A_LTE_MRBTS_LNBTS_LNCEL_LNHOIF", ["thresholdRsrpUlTraffHoFilter", "thresholdRsrqUlTraffHoFilter"]],
  ["A_NRBTS_MRBTS_NRBTS_NRCELL", ["actAdaptiveUlBlerTarget", "actAdmissionCtrlSr", "actAugSrbPrioBoost", "actBadUlRadioHoRej"]],
];
for (const [table, cols] of checks as [string, string[]][]) {
  const t = names.includes(table) ? (db.getTable(table) as any) : null;
  if (!t) {
    console.log(`\n${table}: MISSING`);
    continue;
  }
  const have = new Set(t.getColumns().map((c: { name: string }) => c.name));
  console.log(`\n${table} rows=${t.rowCount}`);
  for (const c of cols) console.log(`  ${c}: ${have.has(c) ? "COLUMN EXISTS" : "no column"}`);
}

for (const kw of ["PAGINGSSB", "ADAPTIVEUL", "FMCADM", "ZEROCOUNTER", "RIMCM", "CBTS", "DPIMEAS", "MLSCELL", "HISTCOUNTER", "ULRIP", "RADIOQUALITY", "X2FLOW", "TRX"]) {
  const hit = names.filter((n) => n.toUpperCase().includes(kw));
  console.log(`\n[${kw}] ${hit.length} tables`);
  for (const n of hit.slice(0, 25)) {
    const t = db.getTable(n) as any;
    console.log(`  ${n} rows=${t.rowCount}`);
  }
}
