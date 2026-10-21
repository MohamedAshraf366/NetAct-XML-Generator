import fs from "node:fs";
import MDBReader from "mdb-reader";

const N = Number(process.argv[2]) || 100000;
const outPath = process.argv[3] || "D:/netact-tmp/fill-input.txt";
const tableName = process.argv[4] || "A_LTE_MRBTS_LNBTS_LNCEL";
const template = "D:/netact-tmp/dbinspect/Dump 4G+5G.mdb";

const reader = new MDBReader(fs.readFileSync(template));
const cols = (reader.getTable(tableName) as unknown as { getColumns: () => { name: string }[] })
  .getColumns()
  .map((c) => c.name);
const values = new Map<string, (i: number) => string>([
  ["mrbtsId", (i) => String(900000 + i)],
  ["lnBtsId", (i) => String(900000 + i)],
  ["lnCelId", () => "1"],
  ["cellName", (i) => `CELL_${i}`],
  ["phyCellId", (i) => String(i % 500)],
  ["angle", () => "90"],
]);
if (cols.some((c) => c === "nms_id")) values.set("nms_id", () => "1");

const b64 = (v: string) => (v === "" ? "!" : Buffer.from(v, "utf8").toString("base64"));

const fd = fs.openSync(outPath, "w");
fs.writeSync(fd, `H\t1\t${tableName}\t${cols.join("\t")}\n`);
let batch: string[] = [];
for (let i = 0; i < N; i++) {
  const pairs: string[] = [];
  for (let c = 0; c < cols.length; c++) {
    const f = values.get(cols[c]);
    if (f) pairs.push(`${c}:${b64(f(i))}`);
  }
  batch.push(`R\t1\t${pairs.join("\t")}\n`);
  if (batch.length >= 5000) {
    fs.writeSync(fd, batch.join(""));
    batch = [];
  }
}
if (batch.length) fs.writeSync(fd, batch.join(""));
fs.writeSync(fd, "E\n");
fs.closeSync(fd);
console.log(`wrote ${outPath} rows=${N} cols=${cols.length} size=${(fs.statSync(outPath).size / 1048576).toFixed(1)}MB`);
