import fs from "node:fs";
import readline from "node:readline";

const file = "D:/netact-tmp/18-8-2026 xml.xml";
const rl = readline.createInterface({ input: fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 }) });

const classes = new Map<string, number>();
const listsPerClass = new Map<string, Map<string, number>>();
let curClass: string | null = null;
let lnceSample: string[] | null = null;
let inLnce = false;
let lnceLines = 0;

const moRe = /<managedObject class="([^"]+)"/;
const listRe = /<list name="([^"]+)"/;

rl.on("line", (line) => {
  const mo = moRe.exec(line);
  if (mo) {
    curClass = mo[1];
    classes.set(curClass, (classes.get(curClass) ?? 0) + 1);
    if (curClass === "LNCEL" && !lnceSample) inLnce = true;
  } else if (inLnce && lnceLines < 400) {
    if (!lnceSample) lnceSample = [];
    lnceSample.push(line);
    lnceLines++;
  }
  const li = listRe.exec(line);
  if (li && curClass) {
    let m = listsPerClass.get(curClass);
    if (!m) listsPerClass.set(curClass, (m = new Map()));
    m.set(li[1], (m.get(li[1]) ?? 0) + 1);
  }
  if (line.includes("</managedObject>")) {
    inLnce = false;
    curClass = null;
  }
});

rl.on("close", () => {
  console.log("distinct classes:", classes.size, "total managedObjects:", [...classes.values()].reduce((a, b) => a + b, 0));
  const top = [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45);
  for (const [c, n] of top) {
    const lists = listsPerClass.get(c);
    const ls = lists ? [...lists.entries()].map(([k, v]) => `${k}:${v}`).join(" ") : "";
    console.log(`${c}: ${n}${ls ? "  lists: " + ls : ""}`);
  }
  console.log("\nclasses with lists (top 40 by classes):");
  for (const [c] of [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400)) {
    const lists = listsPerClass.get(c);
    if (lists) console.log(`${c}: ${[...lists.entries()].map(([k, v]) => `${k}:${v}`).join(" ")}`);
  }
  if (lnceSample) {
    console.log("\nLNCEL sample:");
    console.log(lnceSample.slice(0, 120).join("\n"));
  }
});
