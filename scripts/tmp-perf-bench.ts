import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import MDBReader from "mdb-reader";

const template = "D:/netact-tmp/dbinspect/Dump 4G+5G.mdb";
const N = Number(process.argv[2]) || 200000;
const classes = process.argv[3] || "tools/mdb-fill/classes";
const java = process.argv[4] || "tools/jre/bin/java.exe";
const mode = process.argv[5] || "sorted";
const keyOf = (i: number) => (mode === "random" ? (i * 999983) % N : i);
const tableName = "A_LTE_MRBTS_LNBTS_LNCEL";
const out = `D:/netact-tmp/perf-${N}-${path.basename(path.dirname(classes))}.mdb`;

const reader = new MDBReader(fs.readFileSync(template));
const cols = (reader.getTable(tableName) as unknown as { getColumns: () => { name: string }[] })
  .getColumns()
  .map((c) => c.name);
const valueCols = new Map<string, (i: number) => string>([
  ["mrbtsId", (i) => String(900000 + keyOf(i))],
  ["lnBtsId", (i) => String(900000 + keyOf(i))],
  ["lnCelId", () => "1"],
  ["cellName", (i) => `CELL_${i}`],
  ["phyCellId", (i) => String(i % 500)],
  ["angle", () => "90"],
]);

const b64 = (v: string) => (v === "" ? "!" : Buffer.from(v, "utf8").toString("base64"));

async function main() {
  fs.copyFileSync(template, out);
  const t0 = Date.now();
  const child = spawn(java, ["-Xmx448m", "-Duser.timezone=UTC", "-cp", `${classes};tools/mdb-fill/jackcess-5.0.4.jar`, "MdbFill", out], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 100000) stderr = stderr.slice(-100000);
  });
  const closed = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
  child.stdin!.on("error", () => {});

  const write = async (s: string) => {
    if (!child.stdin!.write(s)) await once(child.stdin!, "drain");
  };

  await write(`H\t1\t${tableName}\t${cols.join("\t")}\n`);
  let batch: string[] = [];
  for (let i = 0; i < N; i++) {
    const pairs: string[] = [];
    for (let c = 0; c < cols.length; c++) {
      const f = valueCols.get(cols[c]);
      if (f) pairs.push(`${c}:${b64(f(i))}`);
    }
    batch.push(`R\t1\t${pairs.join("\t")}\n`);
    if (batch.length >= 5000) {
      await write(batch.join(""));
      batch = [];
    }
  }
  if (batch.length) await write(batch.join(""));
  await write("E\n");
  child.stdin!.end();
  const code = await closed;
  const dt = (Date.now() - t0) / 1000;
  const size = fs.statSync(out).size;
  if (code !== 0) console.error(stderr.slice(-2000));
  console.log(
    `rows=${N} code=${code} time=${dt.toFixed(1)}s rate=${Math.round(N / dt)}/s size=${(size / 1048576).toFixed(1)}MB`,
  );
  const db = new MDBReader(fs.readFileSync(out));
  console.log("rowCount:", db.getTable(tableName).rowCount);
  fs.rmSync(out, { force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
