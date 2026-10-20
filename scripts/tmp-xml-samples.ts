import fs from "node:fs";
import readline from "node:readline";

const targets: Record<string, number> = { LNADJL: 2, LNCEL: 1, NRCELL: 1, SIB: 1, LNREL: 1 };
const got: Record<string, number> = {};
const elements = new Set<string>();
const listNames = new Set<string>();
let current: string[] | null = null;
fs.mkdirSync("D:/netact-tmp/samples", { recursive: true });

const rl = readline.createInterface({ input: fs.createReadStream("D:/netact-tmp/18-8-2026 xml.xml", { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
rl.on("line", (line) => {
  const mo = line.match(/^\s*<managedObject class="([^"]+)"/);
  if (mo) {
    current = [line];
    return;
  }
  if (!current) return;
  current.push(line);
  if (line.includes("</managedObject>")) {
    const cls = current[0].match(/class="([^"]+)"/)![1];
    if (targets[cls] !== undefined && (got[cls] ?? 0) < targets[cls]) {
      got[cls] = (got[cls] ?? 0) + 1;
      const text = current.join("\n");
      fs.writeFileSync(`D:/netact-tmp/samples/${cls}-${got[cls]}.xml`, text);
      for (const m of text.matchAll(/<([a-zA-Z]+)[ >/]/g)) elements.add(m[1]);
      for (const m of text.matchAll(/<list name="([^"]+)"/g)) listNames.add(`${cls}.${m[1]}`);
    }
    current = null;
    if (Object.entries(targets).every(([k, v]) => (got[k] ?? 0) >= v)) rl.close();
  }
});
rl.on("close", () => {
  console.log("got:", JSON.stringify(got));
  console.log("elements seen:", [...elements].join(", "));
  console.log("list names seen:", [...listNames].join(", "));
});
