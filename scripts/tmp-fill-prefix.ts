import fs from "node:fs";
import MDBReader from "mdb-reader";
import { buildFillSchema, fillDatabase } from "../src/lib/fill";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const xmlPath = "D:/netact-tmp/18-8-2026 xml.xml";
const limit = Number(process.argv[2] || 200) * 1024 * 1024;

async function main() {
  const out = `${dir}/prefix-test.mdb`;
  fs.copyFileSync(`${dir}/Dump 4G+5G.mdb`, out);
  const schema = buildFillSchema(out);
  console.log("schema:", schema.stats);

  let pulled = 0;
  const src = (async function* () {
    const clean = (buf: Buffer | Uint8Array) =>
      Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const stream = fs.createReadStream(xmlPath, { highWaterMark: 1 << 20 });
    for await (const c of stream) {
      if (pulled >= limit) {
        stream.destroy();
        return;
      }
      pulled += c.length;
      yield clean(c);
    }
  })();

  const t0 = Date.now();
  const res = await fillDatabase(
    {
      templatePath: out,
      outPath: out,
      xml: src,
      onProgress: (p) => {
        const s = (Date.now() - t0) / 1000;
        console.log(`t=${s.toFixed(0)}s objects=${p.objects} rows=${p.rows} rate=${Math.round(p.rows / Math.max(1, s))}/s`);
      },
    },
    schema,
  );
  const dt = (Date.now() - t0) / 1000;
  const size = fs.statSync(out).size;
  console.log(
    `done: ${dt.toFixed(0)}s objects=${res.objects} parent=${res.parentRows} child=${res.childRows} errors=${res.errors} size=${(size / 1048576).toFixed(1)}MB export=${res.exportTime}`,
  );
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log("skipped:", top(res.skippedClass));
  console.log("unknownParams:", top(res.unknownParams));
  console.log("unknownLists:", top(res.unknownLists));
  console.log("errorTables:", res.errorTables);
  console.log("errorSamples:", res.errorSamples.slice(0, 3));

  const reader = new MDBReader(fs.readFileSync(out));
  for (const t of ["A_LTE_MRBTS_LNBTS_LNCEL", "A_LTE_MRBTS_LNBTS_LNADJ_LNADJL", "A_LTE_LNADJL_BCPLMNIDLIST", "A_LTE_MRBTS_LNBTS_LNCEL_SIBSCHEDULINGLIST"]) {
    try {
      console.log(t, reader.getTable(t).rowCount);
    } catch {
      console.log(t, "MISSING");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
