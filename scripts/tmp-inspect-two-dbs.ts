import fs from "node:fs";
import MDBReader from "mdb-reader";
import { openFileBuffer } from "../src/lib/fileBuffer";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const emptyPath = `${dir}/Dump 4G+5G.mdb`;
const fullPath = `${dir}/18-10-2026.mdb`;

type Info = { name: string; rows: number; cols: string[] };

function list(reader: MDBReader, filter?: (n: string) => boolean): Info[] {
  const names = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
  const out: Info[] = [];
  for (const name of names) {
    if (filter && !filter(name)) continue;
    try {
      const t = reader.getTable(name);
      out.push({ name, rows: t.rowCount, cols: t.getColumnNames() });
    } catch (e) {
      out.push({ name, rows: -1, cols: [String(e)] });
    }
  }
  return out;
}

const empty = list(new MDBReader(fs.readFileSync(emptyPath)));
console.log("EMPTY tables:", empty.length, "total rows:", empty.reduce((n, t) => n + Math.max(0, t.rows), 0));
console.log("EMPTY non-empty tables:");
for (const t of empty.filter((t) => t.rows > 0).sort((a, b) => b.rows - a.rows).slice(0, 40)) {
  console.log(`  ${t.name}: ${t.rows} rows, ${t.cols.length} cols`);
}
console.log("EMPTY tables with cols (sample):");
for (const t of empty.slice(0, 5)) console.log(`  ${t.name}: rows=${t.rows} cols=${t.cols.slice(0, 8).join(",")}`);

const fb = openFileBuffer(fullPath, fs.statSync(fullPath).size);
try {
  const reader = new MDBReader(fb as unknown as Buffer);
  const full = list(reader);
  console.log("\nFULL tables:", full.length, "total rows:", full.reduce((n, t) => n + Math.max(0, t.rows), 0));
  console.log("FULL top tables:");
  for (const t of full.filter((t) => t.rows > 0).sort((a, b) => b.rows - a.rows).slice(0, 40)) {
    console.log(`  ${t.name}: ${t.rows} rows, ${t.cols.length} cols`);
  }
  const emptyByName = new Map(empty.map((t) => [t.name, t]));
  console.log("\nTABLES IN FULL BUT NOT EMPTY (first 30):");
  console.log(full.filter((t) => !emptyByName.has(t.name)).slice(0, 30).map((t) => t.name).join(", "));
  console.log("TABLES IN EMPTY BUT NOT FULL (first 30):");
  const fullByName = new Map(full.map((t) => [t.name, t]));
  console.log(empty.filter((t) => !fullByName.has(t.name)).slice(0, 30).map((t) => t.name).join(", "));
  console.log("\ncolumn diffs for top full tables:");
  for (const t of full.filter((t) => t.rows > 0).sort((a, b) => b.rows - a.rows).slice(0, 12)) {
    const e = emptyByName.get(t.name);
    const extra = t.cols.filter((c) => !e?.cols.includes(c));
    const missing = e?.cols.filter((c) => !t.cols.includes(c)) ?? [];
    console.log(`  ${t.name}: emptyRows=${e?.rows} extraCols=[${extra.join(",")}] missingCols=[${missing.join(",")}]`);
  }
} finally {
  fb.close();
}
