import fs from "node:fs";
import MDBReader from "mdb-reader";
import { openFileBuffer } from "../src/lib/fileBuffer";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const fullPath = `${dir}/18-10-2026.mdb`;
const emptyPath = `${dir}/Dump 4G+5G.mdb`;

function show(label: string, reader: MDBReader, names: string[]) {
  for (const n of names) {
    try {
      const t = reader.getTable(n);
      const rows = t.getData({ rowLimit: 2 }) as Record<string, unknown>[];
      console.log(`\n[${label}] ${n}: ${t.rowCount} rows`);
      console.log("cols:", t.getColumnNames().join(", "));
      for (const r of rows) console.log("row:", JSON.stringify(r).slice(0, 700));
    } catch (e) {
      console.log(`[${label}] ${n}: ${String(e)}`);
    }
  }
}

const names = [
  "A_LTE_MRBTS",
  "A_LTE_MRBTS_LNBTS",
  "A_LTE_MRBTS_LNBTS_LNCEL",
  "A_LTE_MRBTS_LNBTS_LNCEL_LNREL",
  "A_NRBTS_MRBTS_NRBTS_NRCELL",
];

const e = new MDBReader(fs.readFileSync(emptyPath));
show("EMPTY", e, names);

const fb = openFileBuffer(fullPath, fs.statSync(fullPath).size);
try {
  show("FULL", new MDBReader(fb as unknown as Buffer), names);
} finally {
  fb.close();
}

