import fs from "node:fs";
import { buildFillSchema, fillDatabase } from "../src/lib/fill";

const dir = "D:/netact-tmp/dbinspect";
const xmlPath = "D:/netact-tmp/18-8-2026 xml.xml";
const dryClasses = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dry";
const maxBytes = Number(process.argv[2]) || 0;

async function main() {
  const out = "D:/netact-tmp/nodeonly.mdb";
  fs.copyFileSync(`${dir}/Dump 4G+5G.mdb`, out);
  const schema = buildFillSchema(out);
  process.env.MDB_FILL_CLASSES = dryClasses;

  const src = (async function* () {
    const clean = (buf: Buffer | Uint8Array) =>
      Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const stream = fs.createReadStream(xmlPath, { highWaterMark: 4 << 20, ...(maxBytes ? { end: maxBytes - 1 } : {}) });
    for await (const c of stream) yield clean(c);
  })();

  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  let last = 0;
  const res = await fillDatabase(
    {
      templatePath: out,
      outPath: out,
      xml: src,
      onProgress: (p) => {
        const s = (Date.now() - t0) / 1000;
        if (s - last < 30) return;
        last = s;
        console.log(`t=${s.toFixed(0)}s objects=${p.objects} rows=${p.rows} rate=${Math.round(p.rows / Math.max(1, s))}/s`);
      },
    },
    schema,
  );
  const dt = (Date.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  console.log(
    `done: ${dt.toFixed(1)}s cpu=${((cpu.user + cpu.system) / 1e6).toFixed(1)}s objects=${res.objects} parent=${res.parentRows} child=${res.childRows} errors=${res.errors}`,
  );
  fs.rmSync(out, { force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

