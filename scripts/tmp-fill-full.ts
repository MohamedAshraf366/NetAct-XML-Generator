import fs from "node:fs";
import { buildFillSchema, fillDatabase } from "../src/lib/fill";

const dir = "D:/netact-tmp/dbinspect";
const xmlPath = "D:/netact-tmp/18-8-2026 xml.xml";

async function main() {
  const out = "D:/netact-tmp/full-fill.mdb";
  fs.copyFileSync(`${dir}/Dump 4G+5G.mdb`, out);
  const schema = buildFillSchema(out);
  console.log("schema:", schema.stats, "classes", schema.classes.size);

  const src = (async function* () {
    const clean = (buf: Buffer | Uint8Array) =>
      Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const stream = fs.createReadStream(xmlPath, { highWaterMark: 4 << 20 });
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
      xmlPath,
      workers: process.env.FILL_WORKERS ? Number(process.env.FILL_WORKERS) : undefined,
      onProgress: (p) => {
        const s = (Date.now() - t0) / 1000;
        if (s - last < 60) return;
        last = s;
        console.log(`t=${s.toFixed(0)}s objects=${p.objects} rows=${p.rows} rate=${Math.round(p.rows / Math.max(1, s))}/s`);
      },
    },
    schema,
  );
  const dt = (Date.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  const size = fs.statSync(out).size;
  console.log(
    `done: ${dt.toFixed(0)}s cpu=${((cpu.user + cpu.system) / 1e6).toFixed(0)}s objects=${res.objects} parent=${res.parentRows} child=${res.childRows} errors=${res.errors} size=${(size / 1048576).toFixed(1)}MB export=${res.exportTime}`,
  );
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 30);
  console.log("skipped:", top(res.skippedClass));
  console.log("unknownParams:", top(res.unknownParams));
  console.log("unknownLists:", top(res.unknownLists));
  console.log("errorTables:", res.errorTables);
  console.log("errorSamples:", res.errorSamples.slice(0, 10));
  fs.writeFileSync(
    "D:/netact-tmp/full-fill-opt.json",
    JSON.stringify(
      {
        ...res,
        skippedClass: top(res.skippedClass),
        unknownParams: top(res.unknownParams),
        unknownLists: top(res.unknownLists),
        seconds: dt,
        size,
      },
      null,
      1,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
