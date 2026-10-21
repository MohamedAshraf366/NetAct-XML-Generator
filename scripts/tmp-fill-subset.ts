import fs from "node:fs";
import { buildFillSchema, fillDatabase } from "../src/lib/fill";

const dir = "D:/netact-tmp/dbinspect";
const xmlPath = "D:/netact-tmp/18-8-2026 xml.xml";
const maxBytes = Number(process.argv[2]) || 500 * 1024 * 1024;
const out = "D:/netact-tmp/subset-fill.mdb";

async function main() {
  fs.copyFileSync(`${dir}/Dump 4G+5G.mdb`, out);
  const schema = buildFillSchema(out);
  const src = (async function* () {
    const clean = (buf: Buffer | Uint8Array) =>
      Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const stream = fs.createReadStream(xmlPath, { highWaterMark: 4 << 20, end: maxBytes - 1 });
    for await (const c of stream) yield clean(c);
  })();

  const t0 = Date.now();
  const res = await fillDatabase({ templatePath: out, outPath: out, xml: src, xmlPath: process.env.FILL_XML_PATH, workers: Number(process.env.FILL_WORKERS || 0) || undefined }, schema);
  const dt = (Date.now() - t0) / 1000;
  console.log(
    `done bytes=${(maxBytes / 1048576).toFixed(0)}MB ${dt.toFixed(1)}s objects=${res.objects} parent=${res.parentRows} child=${res.childRows} rows=${res.parentRows + res.childRows} errors=${res.errors} size=${(fs.statSync(out).size / 1048576).toFixed(1)}MB`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
