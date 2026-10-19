import { DEFAULT_NR_VERSION, DEFAULT_VERSION, PARAMS, type ParamDef, type Tech } from "./config";
import type { DbObject } from "./db";
import type { Change, Row } from "./types";

/**
 * Canonical form of a value so that "1000" == "1000.0" == " 1000 ".
 *
 * The hot path (a plain non-negative integer, the overwhelmingly common case for RAN parameters)
 * returns the trimmed string directly - half the parsing cost of a `Number()` round-trip per value.
 */
export function norm(v: string | undefined): string {
  if (v === undefined) return "";
  const s = v.trim();
  const len = s.length;
  if (len === 0) return s;
  const c0 = s.charCodeAt(0);
  if (c0 >= 49 && c0 <= 57) {
    // '1'..'9' - scan the remaining chars; a run of pure digits with no leading zero is already canonical.
    let i = 1;
    while (i < len) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    if (i === len) return s;
  } else if (c0 === 48 && len === 1) {
    return s; // "0"
  }
  const n = Number(s);
  return Number.isNaN(n) ? s : String(n);
}

type Ids = { mrbts: number; bts: number; cel: number };

const isDigit = (c: number) => c >= 48 && c <= 57;
const isWS = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * Integer parse for an id column, matching the old `/^-?\d+(\.0+)?$/` test.
 *
 * Hand-rolled (no regex, no `parseInt`) - it runs once per (row, tech) rather than once per
 * (row, parameter), so keeping it allocation-free matters on large CSVs.
 */
function toInt(s: string | undefined): number {
  if (s === undefined) return NaN;
  const n = s.length;
  let i = 0;
  while (i < n && isWS(s.charCodeAt(i))) i++;
  let neg = false;
  if (i < n && s.charCodeAt(i) === 45) {
    neg = true;
    i++;
  }
  const start = i;
  let v = 0;
  while (i < n && isDigit(s.charCodeAt(i))) v = v * 10 + (s.charCodeAt(i++) - 48);
  if (i === start) return NaN;
  if (i < n && s.charCodeAt(i) === 46) {
    // ".0+" fraction only
    i++;
    const frac = i;
    while (i < n && isDigit(s.charCodeAt(i))) {
      if (s.charCodeAt(i) !== 48) return NaN;
      i++;
    }
    if (i === frac) return NaN;
  }
  while (i < n && isWS(s.charCodeAt(i))) i++;
  if (i !== n) return NaN;
  return neg ? -v : v;
}

function idsFor(tech: Tech | undefined, r: Row): Ids | null {
  const mrbts = toInt(r.mrbtsId);
  if (tech === "NR") {
    const cel = toInt(r.nrCellId);
    const bts = r.nrBtsId ? toInt(r.nrBtsId) : mrbts;
    if (Number.isNaN(mrbts) || Number.isNaN(bts) || Number.isNaN(cel)) return null;
    return { mrbts, bts, cel };
  }
  const cel = toInt(r.lnCelId);
  const bts = r.lnBtsId ? toInt(r.lnBtsId) : mrbts;
  if (Number.isNaN(mrbts) || Number.isNaN(bts) || Number.isNaN(cel)) return null;
  return { mrbts, bts, cel };
}

export function baseDistName(tech: Tech | undefined, i: Ids): string {
  if (tech === "NR") {
    return `PLMN-PLMN/MRBTS-${i.mrbts}/NRBTS-${i.bts}/NRCELL-${i.cel}`;
  }
  return `PLMN-PLMN/MRBTS-${i.mrbts}/LNBTS-${i.bts}/LNCEL-${i.cel}`;
}

export function cellDistName(i: Ids) {
  return baseDistName("LTE", i);
}

/** Resolve the full distName a parameter targets. */
export function objectDistName(i: Ids, r: Row, def: ParamDef): string | null {
  const base = baseDistName(def.tech, i);
  if (def.idColumn) {
    const id = (r[def.idColumn] ?? "").trim();
    if (id === "") return null;
    return `${base}/${def.idPrefix ?? ""}${id}`;
  }
  return base + def.suffix;
}

/** Human label for the managed-object class a parameter maps to (used in warnings). */
export function objLabel(def: ParamDef): string {
  if (def.idPrefix) return def.idPrefix.replace(/-$/, "");
  if (def.suffix) return def.suffix.slice(1);
  return def.cls.replace("NOKLTE:", "");
}

const FALLBACK_DEF: ParamDef = { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: false, tech: "LTE" };

const resolveDef = (paramDefs: Record<string, ParamDef>, p: string): ParamDef =>
  paramDefs[p] ?? PARAMS[p] ?? FALLBACK_DEF;

/**
 * Every distName we will need to look up - lets the DB loader skip the rest of the network.
 *
 * Ids and the base distName are resolved once per (row, technology); the per-parameter work is then
 * just a suffix append. This is the difference between ~15 minutes and a few seconds on a big CSV.
 */
export function wantedDistNames(
  rows: Row[],
  params: string[],
  paramDefs: Record<string, ParamDef> = PARAMS,
): Set<string> {
  const out = new Set<string>();
  const defs = params.map((p) => resolveDef(paramDefs, p));

  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    let idsLTE: Ids | null | undefined;
    let idsNR: Ids | null | undefined;
    let baseLTE: string | undefined;
    let baseNR: string | undefined;

    for (let qi = 0; qi < defs.length; qi++) {
      const def = defs[qi];
      const tech = def.tech ?? "LTE";
      let i: Ids | null | undefined;
      let base: string | undefined;
      if (tech === "NR") {
        if (idsNR === undefined) idsNR = idsFor("NR", r);
        i = idsNR;
        if (baseNR === undefined && i) baseNR = baseDistName("NR", i);
        base = baseNR;
      } else {
        if (idsLTE === undefined) idsLTE = idsFor("LTE", r);
        i = idsLTE;
        if (baseLTE === undefined && i) baseLTE = baseDistName("LTE", i);
        base = baseLTE;
      }
      if (!i || !base) continue;

      let dn: string;
      if (def.idColumn) {
        const id = (r[def.idColumn] ?? "").trim();
        if (id === "") continue;
        dn = `${base}/${def.idPrefix ?? ""}${id}`;
      } else {
        dn = base + def.suffix;
      }
      out.add(dn);
    }
  }
  return out;
}

/**
 * Every parameter name the diff may read back out of a database object: the compared parameters,
 * every list-group member (needed to write a complete `<list>`), and the derived input. The XML
 * scanner uses this to skip the bulk of each object's `<p>` children.
 */
export function dbParamNames(params: string[], paramDefs: Record<string, ParamDef> = PARAMS): Set<string> {
  const out = new Set(params);
  // Only groups the user actually compares need their (unselected) members read back for the
  // atomic-list rule. Each name we add here costs one extra search inside every kept object.
  const activeGroups = new Set<string>();
  for (const p of params) {
    const g = paramDefs[p]?.group;
    if (g) activeGroups.add(g);
  }
  for (const name in paramDefs) {
    const def = paramDefs[name];
    if (def.group && activeGroups.has(def.group)) out.add(name);
  }
  if (paramDefs["ssPbchBlockPower"]) out.add("ssPbchBlockPower"); // derived-value input
  return out;
}

/**
 * Compare the planned rows against the database and keep only the differences.
 *
 * Pass `db = null` when the user supplied no database at all: every planned value is then written
 * straight out as an update (nothing to compare against).
 */
export function buildChanges(
  rows: Row[],
  params: string[],
  db: Map<string, DbObject> | null,
  paramDefs: Record<string, ParamDef> = PARAMS,
): { changes: Change[]; warnings: string[]; unchanged: number } {
  const map = new Map<string, Change>();
  const warnings: string[] = [];
  // param -> count + first two examples (the warning only shows two; a huge network must not
  // accumulate every missing distName just to throw the rest away)
  const missingObj = new Map<string, { count: number; examples: string[] }>();
  let notSet = 0;
  let unchanged = 0;

  const defs = params.map((p) => resolveDef(paramDefs, p));

  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const rowNo = ri + 2;
    let idsLTE: Ids | null | undefined;
    let idsNR: Ids | null | undefined;
    let baseLTE: string | undefined;
    let baseNR: string | undefined;

    for (let qi = 0; qi < defs.length; qi++) {
      const p = params[qi];
      const next = r[p];
      if (next === undefined || next === "") continue; // blank CSV cell = nothing planned

      const def = defs[qi];
      const tech = def.tech ?? "LTE";
      let i: Ids | null | undefined;
      let base: string | undefined;
      if (tech === "NR") {
        if (idsNR === undefined) idsNR = idsFor("NR", r);
        i = idsNR;
        if (baseNR === undefined && i) baseNR = baseDistName("NR", i);
        base = baseNR;
      } else {
        if (idsLTE === undefined) idsLTE = idsFor("LTE", r);
        i = idsLTE;
        if (baseLTE === undefined && i) baseLTE = baseDistName("LTE", i);
        base = baseLTE;
      }
      if (!i || !base) {
        warnings.push(`Row ${rowNo}: invalid mrbtsId / bts / cell for ${p} - skipped`);
        continue;
      }

      let dn: string;
      if (def.idColumn) {
        const id = (r[def.idColumn] ?? "").trim();
        if (id === "") {
          warnings.push(`Row ${rowNo}: "${p}" needs a ${def.idColumn} value - skipped`);
          continue;
        }
        dn = `${base}/${def.idPrefix ?? ""}${id}`;
      } else {
        dn = base + def.suffix;
      }

      const cur = db ? db.get(dn) : undefined;
      if (db && !cur) {
        const entry = missingObj.get(p);
        if (entry) {
          entry.count++;
          if (entry.examples.length < 2) entry.examples.push(dn);
        } else {
          missingObj.set(p, { count: 1, examples: [dn] });
        }
        continue;
      }

      const old = cur ? cur.p[p] : undefined;
      if (cur) {
        if (old === undefined) notSet++;
        else if (norm(old) === norm(next)) {
          unchanged++;
          continue;
        }
      }

      let c = map.get(dn);
      if (c === undefined) {
        c = {
          distName: dn,
          cls: def.cls,
          version: cur?.version || (tech === "NR" ? DEFAULT_NR_VERSION : DEFAULT_VERSION),
          mrbts: i.mrbts,
          cel: i.cel,
          params: [],
        };
        map.set(dn, c);
      }
      c.params.push({ name: p, old: old ?? "", new: norm(next), group: def.group });
    }
  }

  // NetAct treats a <list> as one atomic item: when any member of a group changes, the whole
  // group must be written - unchanged members keep the value currently in the database.
  // (Only possible when a database was provided; without one there is nothing to keep.)
  if (db) {
    // group -> member parameter names, built once instead of re-scanning every definition per object.
    const groupMembers = new Map<string, string[]>();
    for (const name in paramDefs) {
      const g = paramDefs[name].group;
      if (!g) continue;
      const list = groupMembers.get(g);
      if (list) list.push(name);
      else groupMembers.set(g, [name]);
    }

    for (const c of map.values()) {
      const cur = db.get(c.distName);
      if (!cur) continue;
      const present = new Set<string>();
      for (const p of c.params) if (p.group) present.add(p.group);
      for (const g of present) {
        const members = groupMembers.get(g);
        if (!members) continue;
        const have = new Set<string>();
        for (const p of c.params) if (p.group === g) have.add(p.name);
        for (const pname of members) {
          if (have.has(pname)) continue;
          const val = (cur.p[pname] ?? "").trim();
          if (val === "") continue; // nothing set in the database - nothing to keep
          c.params.push({ name: pname, old: val, new: val, group: g, filler: true });
          unchanged++;
        }
      }
    }
  }

  // NetAct rule: ssPbchBlockPower must be 3 dB below csirsPower. When csirsPower is being
  // changed and ssPbchBlockPower was not entered, the missing value is derived automatically;
  // an explicitly entered value is kept but a mismatch is warned about.
  for (const c of map.values()) {
    let csirs: (typeof c.params)[number] | undefined;
    let existing: (typeof c.params)[number] | undefined;
    for (const p of c.params) {
      if (p.filler) continue;
      if (p.name === "csirsPower") csirs = p;
      else if (p.name === "ssPbchBlockPower") existing = p;
    }
    if (!csirs) continue;
    const power = Number(csirs.new);
    if (!Number.isFinite(power)) continue;
    const target = power - 3;
    if (existing) {
      if (norm(existing.new) !== norm(String(target))) {
        warnings.push(
          `${c.distName.replace("PLMN-PLMN/", "")}: ssPbchBlockPower is ${existing.new} but csirsPower (${csirs.new}) implies ${target}.`,
        );
      }
      continue;
    }
    const cur = db ? db.get(c.distName) : undefined;
    if (cur && norm(cur.p.ssPbchBlockPower ?? "") === norm(String(target))) continue; // already correct in the database
    c.params.push({ name: "ssPbchBlockPower", old: cur?.p.ssPbchBlockPower ?? "", new: String(target), derived: true });
  }

  for (const [p, { count, examples }] of missingObj) {
    const def = resolveDef(paramDefs, p);
    const obj = objLabel(def);
    const eg = examples.map((d) => d.replace("PLMN-PLMN/", "")).join(", ");
    warnings.push(`${p}: ${count} planned value(s) skipped - no ${obj} object in the database (e.g. ${eg})`);
  }
  if (notSet > 0) {
    warnings.push(`${notSet} value(s) are not set in the database export and were treated as new values.`);
  }

  // NetAct plan files list objects in plain text order of distName (so LNCEL-10 comes before LNCEL-9).
  const changes = [...map.values()].sort((a, b) => (a.distName < b.distName ? -1 : a.distName > b.distName ? 1 : 0));
  return { changes, warnings, unchanged };
}
