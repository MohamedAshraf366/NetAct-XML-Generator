/**
 * npm run test:mdb - tests the Access MDB database loader against cached.mdb and cached.rar.
 */
import fs from "node:fs";
import path from "node:path";
import { kindOf, loadDb } from "../src/lib/db";
import { readInput, canonicalize } from "../src/lib/input";
import { PARAM_NAMES, DEFAULT_VERSION } from "../src/lib/config";
import { buildChanges, wantedDistNames } from "../src/lib/diff";
import { writeRaml } from "../src/lib/xml";

let pass = 0;
let fail = 0;

function assert(condition: boolean, label: string, detail = "") {
  if (condition) {
    pass++;
    console.log(`PASS  ${label}${detail ? " -> " + detail : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? " -> " + detail : ""}`);
  }
}

(async () => {
  console.log("=== Testing Access MDB Support ===\n");

  // 1. Magic byte & extension detection
  const dummyJet = Buffer.alloc(32);
  dummyJet.write("Standard Jet DB", 4, "latin1");
  assert(kindOf("data.bin", dummyJet) === "mdb", "kindOf detects Jet MDB magic bytes");

  const dummyAce = Buffer.alloc(32);
  dummyAce.write("Standard ACE DB", 4, "latin1");
  assert(kindOf("data.bin", dummyAce) === "mdb", "kindOf detects ACE DB magic bytes");

  assert(kindOf("test.mdb", Buffer.alloc(10)) === "mdb", "kindOf detects .mdb extension");
  assert(kindOf("test.accdb", Buffer.alloc(10)) === "mdb", "kindOf detects .accdb extension");

  // 2. Test reading cached.mdb if present
  const mdbPath = path.join(__dirname, "..", "cached.mdb");
  if (!fs.existsSync(mdbPath)) {
    console.log("\nNote: cached.mdb not found on disk, skipping live database tests.");
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  const mdbBuf = fs.readFileSync(mdbPath);
  console.log(`Loaded cached.mdb (${(mdbBuf.length / 1048576).toFixed(1)} MB)`);

  const csvPath = path.join(__dirname, "..", "samples", "700.csv");
  const expPath = path.join(__dirname, "..", "samples", "700.expected.xml");
  const csvBuf = fs.readFileSync(csvPath);
  const expXml = fs.readFileSync(expPath, "utf8");

  const parsed = await readInput("700.csv", csvBuf);
  const { header, rows } = canonicalize(parsed.header, parsed.rows, ["mrbtsId", "lnBtsId", "lnCelId", ...PARAM_NAMES]);
  const params = ["angle", "dlRsBoost"];
  const wanted = wantedDistNames(rows, params);

  console.time("loadDb(mdb)");
  const loaded = await loadDb([{ name: "11-10-2026.mdb", data: mdbBuf }], wanted);
  console.timeEnd("loadDb(mdb)");

  assert(loaded.filesRead === 1, "MDB file loaded count", `filesRead=${loaded.filesRead}`);
  assert(loaded.scanned > 30000, "MDB objects scanned", `scanned=${loaded.scanned}`);
  assert(loaded.objects.size === wanted.size, "MDB wanted cells matched", `matched=${loaded.objects.size}`);

  const { changes, unchanged } = buildChanges(rows, params, loaded.objects);
  assert(changes.length === 49, "Correct number of changes found", `changes=${changes.length}`);
  assert(unchanged === 115, "Correct number of unchanged values", `unchanged=${unchanged}`);

  const out = writeRaml(changes, "700");
  const strip = (s: string) => s.replace(/dateTime="[^"]+"/, "");
  assert(strip(out) === strip(expXml), "Generated XML exactly equals 700.expected.xml");

  // 3. Test fallback parameter mapping
  const customParamDefs = {
    customTilt: { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: true },
  };
  const customWanted = wantedDistNames(rows, ["customTilt"], customParamDefs);
  assert(customWanted.size > 0, "Custom paramDef produces wanted distNames", `size=${customWanted.size}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
