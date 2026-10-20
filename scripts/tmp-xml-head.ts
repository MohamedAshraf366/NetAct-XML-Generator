import { spawn } from "node:child_process";

const unrar = "C:/Program Files/WinRAR/UnRAR.exe";
const archive = "C:/Users/ELBOSTAN/Downloads/18-8-2026 xml.rar";
const member = "18-8-2026 xml.xml";

const child = spawn(unrar, ["p", "-inul", "-p-", archive, member], { stdio: ["ignore", "pipe", "pipe"] });
let buf = Buffer.alloc(0);
let done = false;
child.stdout.on("data", (c: Buffer) => {
  if (done) return;
  buf = Buffer.concat([buf, c]);
  if (buf.length > 512 * 1024) {
    done = true;
    child.kill();
  }
});
child.on("error", (e) => console.error(e));
child.on("close", () => {
  const s = buf.toString("utf8", 0, Math.min(buf.length, 512 * 1024));
  const start = s.indexOf("<managedObject");
  console.log("XML prefix:", s.slice(0, start));
  const re = /<managedObject[\s\S]*?<\/managedObject>/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s)) && n < 4) {
    console.log(`\n--- object ${n} (${m[0].length} chars) ---`);
    console.log(m[0].slice(0, 2500));
    n++;
  }
});
