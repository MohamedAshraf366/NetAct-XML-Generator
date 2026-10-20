import { spawn } from "node:child_process";

const unrar = "C:/Program Files/WinRAR/UnRAR.exe";
const archive = "C:/Users/ELBOSTAN/Downloads/18-8-2026 xml.rar";
const member = "18-8-2026 xml.xml";
const LIMIT = 32 * 1024 * 1024;

const child = spawn(unrar, ["p", "-inul", "-p-", archive, member], { stdio: ["ignore", "pipe", "ignore"] });
let buf = Buffer.alloc(0);
let done = false;
child.stdout.on("data", (c: Buffer) => {
  if (done) return;
  buf = Buffer.concat([buf, c]);
  if (buf.length > LIMIT) {
    done = true;
    child.kill();
  }
});
child.on("close", () => {
  const s = buf.toString("utf8");
  const i = s.indexOf("<list");
  console.log("first <list> at", i);
  if (i >= 0) console.log(s.slice(Math.max(0, i - 1000), i + 1400));
  const cls = new Map<string, number>();
  for (const m of s.matchAll(/class="([^"]+)"/g)) cls.set(m[1], (cls.get(m[1]) ?? 0) + 1);
  console.log("classes:", [...cls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
});
