import { DEFAULT_VERSION, PARAMS, type ParamDef } from "./config";
import type { DbObject } from "./db";
import type { Change, Row } from "./types";

/** "1000" == "1000.0" == " 1000 " */
export function norm(v: string | undefined): string {
  const s = (v ?? "").trim();
  if (s !== "" && !Number.isNaN(Number(s))) return String(Number(s));
  return s;
}

type Ids = { mrbts: number; bts: number; cel: number };

function ids(r: Row): Ids | null {
  const toInt = (s: string | undefined) => (s && /^-?\d+(\.0+)?$/.test(s.trim()) ? parseInt(s, 10) : NaN);
  const mrbts = toInt(r.mrbtsId);
  const cel = toInt(r.lnCelId);
  const bts = r.lnBtsId ? toInt(r.lnBtsId) : mrbts;
  if ([mrbts, bts, cel].some(Number.isNaN)) return null;
  return { mrbts, bts, cel };
}

export function cellDistName(i: Ids) {
  return `PLMN-PLMN/MRBTS-${i.mrbts}/LNBTS-${i.bts}/LNCEL-${i.cel}`;
}

/** Every distName we will need to look up - lets the DB loader skip the rest of the network. */
export function wantedDistNames(
  rows: Row[],
  params: string[],
  paramDefs: Record<string, ParamDef> = PARAMS,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const i = ids(r);
    if (!i) continue;
    for (const p of params) {
      const def = paramDefs[p] ?? PARAMS[p];
      if (def) out.add(cellDistName(i) + def.suffix);
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
    const i = ids(r);
    if (!i) {
      warnings.push(`Row ${idx + 2}: invalid mrbtsId / lnBtsId / lnCelId - skipped`);
      return;
    }
    for (const p of params) {
      const next = r[p];
      if (next === undefined || next === "") continue; // blank CSV cell = nothing planned

      const def = paramDefs[p] ?? PARAMS[p] ?? { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: false };
      const dn = cellDistName(i) + def.suffix;
      const cur = db ? db.get(dn) : undefined;
      if (db && !cur) {
        const list = missingObj.get(p) ?? [];
        list.push(dn);
        missingObj.set(p, list);
        continue;
      }

      // Parameter absent from the DB export = currently unset, so the planned value IS a change.
      // With no database at all there is nothing to compare, so every planned value is a change.
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
          version: cur?.version || DEFAULT_VERSION,
          mrbts: i.mrbts,
          cel: i.cel,
          params: [],
        } satisfies Change);
      c.params.push({ name: p, old: old ?? "", new: norm(next) });
      map.set(dn, c);
    }
  });

  for (const [p, list] of missingObj) {
    const def = paramDefs[p] ?? PARAMS[p] ?? { cls: "NOKLTE:LNCEL", suffix: "" };
    const obj = def.suffix ? def.suffix.slice(1) : def.cls.replace("NOKLTE:", "");
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
