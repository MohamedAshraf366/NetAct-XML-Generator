/**
 * Performance benchmark:  npm run bench
 *
 * Builds a synthetic (but realistic-shaped) network dump and planned-value CSV in memory, then
 * times the three pipeline stages separately: DB load (XML scan), wanted-set build, and diff.
 * Numbers are printed in milliseconds; lower is better. The layout of the synthetic dump mirrors
 * a real NetAct export (many managed objects per cell, most of them irrelevant to the diff).
 */
import { paramsFor } from "../src/lib/config";
import { buildChanges, dbParamNames, wantedDistNames } from "../src/lib/diff";
import { loadDb } from "../src/lib/db";
import type { Row } from "../src/lib/types";

const CELLS = Number(process.env.BENCH_CELLS ?? 20000);
const EXTRA_OBJECTS = Number(process.env.BENCH_EXTRA ?? 200000);
const OTHER_PARAMS = Number(process.env.BENCH_OTHER ?? 120);

function buildDump() {
  const extra = ["ANR", "IRAT", "PAG", "RAC", "HOC"];
  const parts: string[] = ['<?xml version="1.0"?><raml xmlns="raml21.xsd" version="2.1"><cmData type="actual">'];
  for (let n = 0; n < EXTRA_OBJECTS; n++) {
    const cls = extra[n % extra.length];
    const cells: string[] = [];
    for (let k = 0; k < 20; k++) cells.push(`<p name="filler${k}">${k}</p>`);
    parts.push(
      `<managedObject class="NOKLTE:${cls}" operation="create" version="xL24R3" distName="PLMN-PLMN/MRBTS-${n % 900}/LNBTS-${n % 900}/${cls}-${n}">${cells.join("")}</managedObject>`,
    );
  }
  const names: string[] = [];
  for (let k = 0; k < OTHER_PARAMS; k++) names.push(`otherParam${k}`);
  for (let n = 0; n < CELLS; n++) {
    const mrbts = 100000 + (n % 900);
    const dn = `PLMN-PLMN/MRBTS-${mrbts}/LNBTS-${mrbts}/LNCEL-${100 + (n % 20)}`;
    const ps: string[] = [];
    for (let k = 0; k < OTHER_PARAMS; k++) ps.push(`<p name="${names[k]}">${k}</p>`);
    for (const [p, def] of Object.entries(paramsFor("LTE"))) {
      if (def.idColumn) continue;
      ps.push(`<p name="${p}">OLD</p>`);
    }
    parts.push(
      `<managedObject class="NOKLTE:LNCEL" operation="create" version="xL24R3_2413_110" distName="${dn}">${ps.join("")}</managedObject>`,
    );
  }
  parts.push("</cmData></raml>");
  return Buffer.from(parts.join(""), "utf8");
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (let n = 0; n < CELLS; n++) {
    rows.push({
      mrbtsId: String(100000 + (n % 900)),
      lnBtsId: String(100000 + (n % 900)),
      lnCelId: String(100 + (n % 20)),
      angle: String(10 + (n % 350)),
      phyCellId: String(n % 500),
      tac: "1",
      pMax: "46",
      dlRsBoost: "0",
    });
  }
  return rows;
}

function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(22)} ${ms.toFixed(1).padStart(9)} ms`);
  return out;
}

const gc = (global as { gc?: () => void }).gc;

/** Runs `reps` times and keeps the fastest - min is far more stable than mean on a busy machine. */
async function minOf<T>(reps: number, fn: () => T | Promise<T>): Promise<{ ms: number; out: T }> {
  let best = Infinity;
  let out!: T;
  for (let i = 0; i < reps; i++) {
    gc?.();
    const t0 = performance.now();
    out = await fn();
    const ms = performance.now() - t0;
    if (ms < best) best = ms;
  }
  return { ms: best, out };
}

(async () => {
  console.log(`cells=${CELLS} extraObjects=${EXTRA_OBJECTS} otherParamsPerCell=${OTHER_PARAMS}`);
  const db = time("build dump", buildDump);
  const rows = time("build rows", buildRows);
  const params = Object.keys(paramsFor("LTE")).filter((p) => !paramsFor("LTE")[p].idColumn);
  const dbParams = dbParamNames(params);

  const w = await minOf(5, () => wantedDistNames(rows, params));
  const wanted = w.out;
  const l = await minOf(3, () => loadDb([{ name: "dump.xml", data: db }], wanted, dbParams));
  const loaded = l.out;
  const c = await minOf(5, () => buildChanges(rows, params, loaded.objects));

  const fmt = (label: string, ms: number) => console.log(`  ${label.padEnd(22)} ${ms.toFixed(1).padStart(9)} ms`);
  fmt("wantedDistNames", w.ms);
  fmt("loadDb (async)", l.ms);
  fmt("buildChanges", c.ms);
  fmt("TOTAL engine", w.ms + l.ms + c.ms);

  let values = 0;
  for (const ch of c.out.changes) values += ch.params.length;
  console.log(`  result                 ${c.out.changes.length} objects / ${values} values / matched ${loaded.objects.size} / scanned ${loaded.scanned}`);
})();
