import { DEFAULT_NR_VERSION, DEFAULT_VERSION, PARAMS, type ParamDef, type Tech } from "./config";
import type { DbObject } from "./db";
import type { Change, Row } from "./types";

/** "1000" == "1000.0" == " 1000 " */
export function norm(v: string | undefined): string {
  const s = (v ?? "").trim();
  if (s !== "" && !Number.isNaN(Number(s))) return String(Number(s));
  return s;
}

type Ids = { mrbts: number; bts: number; cel: number };

function idsFor(tech: Tech | undefined, r: Row): Ids | null {
  const t = tech ?? "LTE";
  const toInt = (s: string | undefined) => (s && /^-?\d+(\.0+)?$/.test(s.trim()) ? parseInt(s, 10) : NaN);
  const mrbts = toInt(r.mrbtsId);
  if (t === "NR") {
    const cel = toInt(r.nrCellId);
    const bts = r.nrBtsId ? toInt(r.nrBtsId) : mrbts;
    if ([mrbts, bts, cel].some(Number.isNaN)) return null;
    return { mrbts, bts, cel };
  }
  const cel = toInt(r.lnCelId);
  const bts = r.lnBtsId ? toInt(r.lnBtsId) : mrbts;
  if ([mrbts, bts, cel].some(Number.isNaN)) return null;
  return { mrbts, bts, cel };
}

function ids(r: Row): Ids | null {
  return idsFor("LTE", r);
}

export function baseDistName(tech: Tech | undefined, i: Ids): string {
  const t = tech ?? "LTE";
  if (t === "NR") {
    return `PLMN-PLMN/MRBTS-${i.mrbts}/NRBTS-${i.bts}/NRCELL-${i.cel}`;
  }
  return `PLMN-PLMN/MRBTS-${i.mrbts}/LNBTS-${i.bts}/LNCEL-${i.cel}`;
}

export function cellDistName(i: Ids) {
  return baseDistName("LTE", i);
}

/** Resolve the full distName a parameter targets. */
export function objectDistName(i: Ids, r: Row, def: ParamDef): string | null {
  const tech = def.tech ?? "LTE";
  const base = baseDistName(tech, i);
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

/** Every distName we will need to look up - lets the DB loader skip the rest of the network. */
export function wantedDistNames(
  rows: Row[],
  params: string[],
  paramDefs: Record<string, ParamDef> = PARAMS,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    for (const p of params) {
      const def = paramDefs[p] ?? PARAMS[p];
      if (!def) continue;
      const i = idsFor(def.tech, r);
      if (!i) continue;
      const dn = objectDistName(i, r, def);
      if (dn) out.add(dn);
    }
  }
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
  const missingObj = new Map<string, string[]>(); // param -> distNames without a DB object
  let notSet = 0;
  let unchanged = 0;

  rows.forEach((r, idx) => {
    for (const p of params) {
      const next = r[p];
      if (next === undefined || next === "") continue; // blank CSV cell = nothing planned

      const def = paramDefs[p] ?? PARAMS[p] ?? { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: false, tech: "LTE" };
      const tech = def.tech ?? "LTE";
      const i = idsFor(tech, r);
      if (!i) {
        warnings.push(`Row ${idx + 2}: invalid mrbtsId / bts / cell for ${p} - skipped`);
        continue;
      }
      const dn = objectDistName(i, r, def);
      if (dn === null) {
        warnings.push(`Row ${idx + 2}: "${p}" needs a ${def.idColumn} value - skipped`);
        continue;
      }
      const cur = db ? db.get(dn) : undefined;
      if (db && !cur) {
        const list = missingObj.get(p) ?? [];
        list.push(dn);
        missingObj.set(p, list);
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

      const c =
        map.get(dn) ??
        ({
          distName: dn,
          cls: def.cls,
          version: cur?.version || (tech === "NR" ? DEFAULT_NR_VERSION : DEFAULT_VERSION),
          mrbts: i.mrbts,
          cel: i.cel,
          params: [],
        } satisfies Change);
      c.params.push({ name: p, old: old ?? "", new: norm(next), group: def.group });
      map.set(dn, c);
    }
  });

  for (const [p, list] of missingObj) {
    const def = paramDefs[p] ?? PARAMS[p] ?? { cls: "NOKLTE:LNCEL", suffix: "", tech: "LTE" };
    const obj = objLabel(def);
    const eg = list.slice(0, 2).map((d) => d.replace("PLMN-PLMN/", "")).join(", ");
    warnings.push(`${p}: ${list.length} planned value(s) skipped - no ${obj} object in the database (e.g. ${eg})`);
  }
  if (notSet > 0) {
    warnings.push(`${notSet} value(s) are not set in the database export and were treated as new values.`);
  }

  // NetAct plan files list objects in plain text order of distName (so LNCEL-10 comes before LNCEL-9).
  const changes = [...map.values()].sort((a, b) => (a.distName < b.distName ? -1 : a.distName > b.distName ? 1 : 0));
  return { changes, warnings, unchanged };
}
