import fs from "node:fs";
import { parseManagedObjectBody } from "../src/lib/fill";

const file = process.argv[2] || "D:/netact-tmp/bodies.bin";
const rounds = Number(process.argv[3]) || 1;
const buf = fs.readFileSync(file);
const bodies: Buffer[] = [];
for (let off = 0; off + 4 <= buf.length; ) {
  const n = buf.readUInt32LE(off);
  off += 4;
  bodies.push(buf.subarray(off, off + n));
  off += n;
}
console.log(`bodies=${bodies.length} bytes=${buf.length}`);

for (let r = 0; r < rounds; r++) {
  let params = 0;
  let lists = 0;
  const t0 = Date.now();
  for (let i = 0; i < bodies.length; i++) {
    const parsed = parseManagedObjectBody(bodies[i]);
    params += parsed.params.length / 2;
    lists += parsed.lists.size;
  }
  const dt = (Date.now() - t0) / 1000;
  console.log(`round=${r} t=${dt.toFixed(2)}s bodies/s=${Math.round(bodies.length / dt)} params=${params} lists=${lists}`);
}
