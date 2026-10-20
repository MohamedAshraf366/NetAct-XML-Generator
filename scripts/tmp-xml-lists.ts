import fs from "node:fs";

const t = fs.readFileSync("D:/netact-tmp/samples/NRCELL-1.xml", "utf8");
for (const name of ["dlPtrs", "dlCqiRestriction", "a4PeriodicMeasControlSA", "srsForBeamMgmt", "ulPtrs", "actCsiResAllocOptList", "beamSet", "cellBwpList"]) {
  const i = t.indexOf(`<list name="${name}"`);
  console.log(`=== ${name}: ${i}`);
  if (i >= 0) console.log(t.slice(i, i + 1100).split("\n").slice(0, 30).join("\n"));
}
