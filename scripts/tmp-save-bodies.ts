import fs from "node:fs";
import { parseXmlStream } from "../src/lib/xmlscan";

const xmlPath = process.argv[2] || "D:/netact-tmp/18-8-2026 xml.xml";
const outPath = process.argv[3] || "D:/netact-tmp/bodies.bin";
const maxBodies = Number(process.argv[4]) || 200000;
const maxBytes = Number(process.argv[5]) || 800 * 1024 * 1024;

async function main() {
  const fd = fs.openSync(outPath, "w");
  let n = 0;
  let bytes = 0;
  const t0 = Date.now();
  const src = (async function* () {
    const stream = fs.createReadStream(xmlPath, { highWaterMark: 4 << 20 });
    for await (const c of stream) yield c as Buffer;
  })();
  await parseXmlStream(src, {
    onTag() {
      return true;
    },
    onBody(body) {
      if (bytes + body.length + 4 > maxBytes) return;
      const len = Buffer.allocUnsafe(4);
      len.writeUInt32LE(body.length);
      fs.writeSync(fd, len);
      fs.writeSync(fd, body);
      n++;
      bytes += body.length + 4;
      if (n % 20000 === 0) console.log(`bodies=${n} bytes=${(bytes / 1048576).toFixed(0)}MB t=${((Date.now() - t0) / 1000).toFixed(0)}s`);
    },
  });
  fs.closeSync(fd);
  console.log(`done bodies=${n} bytes=${bytes} t=${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
