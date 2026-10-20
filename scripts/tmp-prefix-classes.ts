import fs from "node:fs";

const fd = fs.openSync("D:/netact-tmp/18-8-2026 xml.xml", "r");
const b = Buffer.alloc(200 * 1024 * 1024);
const n = fs.readSync(fd, b, 0, b.length, 0);
fs.closeSync(fd);
const s = b.toString("utf8", 0, n);
const m = new Map<string, number>();
for (const x of s.matchAll(/<managedObject class="([^"]+)"/g)) m.set(x[1], (m.get(x[1]) ?? 0) + 1);
console.log("classes", m.size);
console.log(
  [...m]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("\n"),
);
