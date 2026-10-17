/**
 * Regression check:  npm run verify
 *
 * For every samples/<name>.csv that has a hand-made samples/<name>.expected.xml, build a stand-in database in
 * which EXACTLY the cells listed in the expected XML differ from the CSV, run the real pipeline
 * (CSV reader -> DB loader -> diff -> XML writer) and require the output to equal the expected XML
 * (ignoring only the creation timestamp).
 *
 * The stand-in database is written to samples/<name>.test-db.xml so you can also try it in the UI.
 * It is SYNTHETIC - it is not your real network database.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ALL_PARAM_NAMES,
  DEFAULT_NR_PARAM_NAMES,
  DEFAULT_NR_VERSION,
  DEFAULT_PARAM_NAMES,
  DEFAULT_VERSION,
  paramNamesFor,
  paramsFor,
  type ParamDef,
} from "../src/lib/config";
import { buildChanges, dbParamNames, objectDistName, wantedDistNames } from "../src/lib/diff";
import { loadDb } from "../src/lib/db";
import { canonicalize, readInput } from "../src/lib/input";
import { writeRaml } from "../src/lib/xml";

const dir = path.join(__dirname, "..", "samples");
const stripTime = (s: string) => s.replace(/dateTime="[^"]+"/, 'dateTime=""');
const squash = (s: string) => stripTime(s).replace(/>\s+</g, "><");
let failed = 0;

const ID_COLS = ["mrbtsId", "lnBtsId", "lnCelId", "lnRelId", "nrBtsId", "nrCellId"];

async function check(name: string, selected: string[], label: string, db: Buffer, csv: Buffer, expected: string, allParams: Record<string, ParamDef>) {
  const parsed = await readInput(`${name}.csv`, csv);
  const { header, rows } = canonicalize(parsed.header, parsed.rows, [...ID_COLS, ...ALL_PARAM_NAMES]);
  const params = selected.filter((p) => header.includes(p));
  // Use the same parameter filter the app passes, so this also guards the fast XML-scan path.
  const loaded = await loadDb(
    [{ name: `${name}.test-db.xml`, data: db }],
    wantedDistNames(rows, params, allParams),
    dbParamNames(params, allParams),
  );
  const { changes, warnings } = buildChanges(rows, params, loaded.objects, allParams);
  const planName = expected.match(/<cmData[^>]*\bname="([^"]*)"/)?.[1] ?? name;
  const out = writeRaml(changes, planName);
  const exact = stripTime(out) === stripTime(expected);
  const ok = exact || squash(out) === squash(expected); // a hand-edited file may only differ in line breaks
  console.log(`${ok ? (exact ? "PASS" : "PASS*") : "FAIL"}  ${name.padEnd(8)} ${label.padEnd(18)} ${changes.length} objects (expected ${(expected.match(/<managedObject /g) ?? []).length})`);
  if (!ok) {
    failed++;
    const a = stripTime(out).split("<managedObject ");
    const b = stripTime(expected).split("<managedObject ");
    const i = a.findIndex((x, k) => x !== b[k]);
    console.log("   first difference at entry", i, "\n   got:      ", a[i], "\n   expected: ", b[i]);
  }
  return warnings;
}

(async () => {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".expected.xml")).map((f) => f.replace(".expected.xml", ""));
  for (const name of names.sort()) {
    const csv = fs.readFileSync(path.join(dir, `${name}.csv`));
    const expected = fs.readFileSync(path.join(dir, `${name}.expected.xml`), "utf8");
    const differ = new Set<string>(); // "distName|param" listed in the expected XML
    const versions = new Map<string, string>();
    for (const m of expected.matchAll(/distName="([^"]+)">([\s\S]*?)<\/managedObject>/g)) {
      for (const pm of m[2].matchAll(/<p name="(\w+)">/g)) differ.add(`${m[1]}|${pm[1]}`);
    }
    for (const m of expected.matchAll(/<managedObject[^>]*\bversion="([^"]*)"[^>]*\bdistName="([^"]*)"/g)) {
      versions.set(m[2], m[1]);
    }

    const parsed = await readInput(`${name}.csv`, csv);
    const { header, rows } = canonicalize(parsed.header, parsed.rows, [...ID_COLS, ...ALL_PARAM_NAMES]);
    const isNr = header.includes("nrCellId");
    const tdd = header.includes("dlSectorBFWeightProfName");
    const techParams = paramsFor(isNr ? "NR" : "LTE");
    const paramNames = paramNamesFor(isNr ? "NR" : "LTE");
    const defaults = isNr ? DEFAULT_NR_PARAM_NAMES : DEFAULT_PARAM_NAMES;
    const fallbackVersion = isNr ? DEFAULT_NR_VERSION : DEFAULT_VERSION;

    // stand-in database
    let flip = 0;
    const mos: string[] = [];
    for (const r of rows) {
      const i = {
        mrbts: +r.mrbtsId,
        bts: +(r.nrBtsId || r.lnBtsId || r.mrbtsId),
        cel: +(r.nrCellId || r.lnCelId),
      };
      const byDn = new Map<string, { cls: string; ps: string[] }>();
      for (const p of paramNames) {
        const def = techParams[p];
        if (!header.includes(p) || r[p] === "") continue;
        const isTddParam = def.cls.endsWith("TDD"), isFddParam = def.cls.endsWith("FDD");
        if ((isTddParam && !tdd) || (isFddParam && tdd)) continue; // a TDD cell has no LNCEL_FDD object and vice-versa
        const dn = objectDistName(i, r, def);
        if (!dn) continue;
        const differs = differ.has(`${dn}|${p}`);
        // alternate between "old value" and "parameter not set in DB" for differing TDD profile values
        const omit = differs && isTddParam && flip++ % 2 === 0;
        const g = byDn.get(dn) ?? { cls: def.cls, ps: [] };
        if (!omit) g.ps.push(`<p name="${p}">${differs ? "OLD" : r[p]}</p>`);
        byDn.set(dn, g);
      }
      for (const [dn, g] of byDn)
        mos.push(`<managedObject class="${g.cls}" operation="create" version="${versions.get(dn) ?? fallbackVersion}" distName="${dn}">${g.ps.join("")}</managedObject>`);
    }
    const dbXml = `<?xml version="1.0"?><raml xmlns="raml21.xsd" version="2.1"><cmData type="actual">${mos.join("")}</cmData></raml>`;
    fs.writeFileSync(path.join(dir, `${name}.test-db.xml`), dbXml);
    const db = Buffer.from(dbXml);

    const w = await check(name, defaults, "default parameters", db, csv, expected, techParams);
    await check(name, paramNames, "all parameters", db, csv, expected, techParams);
    for (const x of w) console.log("   note:", x);
  }
  if (names.length) {
    console.log("\nPASS* = identical apart from line breaks between elements (layout only).");
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
