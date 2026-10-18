import MDBReader from "mdb-reader";
import { DEFAULT_NR_VERSION, DEFAULT_VERSION, NR_PARAMS, PARAM_NAMES } from "./config";
import { ingest, kindOf, type DbSinks } from "./archive";
import { makeScanSink, parseXmlStream, attrValue, type DbLoad, type DbObject, type XmlTagSink } from "./xmlscan";

export { kindOf, parseXmlStream, attrValue };
export type { Kind } from "./archive";
export type { DbObject, DbLoad, XmlTagSink } from "./xmlscan";

const PARAM_NAME_SET = new Set(PARAM_NAMES);

function findCol(cols: string[], candidates: string[]): string | undefined {
  const lowerCols = cols.map((c) => c.toLowerCase());
  for (const cand of candidates) {
    const idx = lowerCols.indexOf(cand.toLowerCase());
    if (idx !== -1) return cols[idx];
  }
  return undefined;
}

/**
 * Scan an Access database (.mdb / .accdb).
 * Identifies LNCEL, LNCEL_FDD, LNCEL_TDD and LNCEL_PC tables, reads only requested parameter
 * columns, and maps them to distNames for fast in-memory diffing.
 */
function scanMdb(data: Buffer, wanted: Set<string>, into: DbLoad) {
  const reader = new MDBReader(data);
  const tables = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });

  // 1. Locate LNCEL table (e.g. A_LTE_MRBTS_LNBTS_LNCEL or LNCEL)
  const lncelTableName =
    tables.find((t) => /^(?:[A-Z]_)?(?:LTE_MRBTS_LNBTS_)?LNCEL$/i.test(t)) ??
    tables.find((t) => /LNCEL$/i.test(t) && !/FDD|TDD|PC|_/i.test(t.replace(/^(?:[A-Z]_)?(?:LTE_MRBTS_LNBTS_)?/, "")));

  // 2. Locate LNCEL_FDD table
  const fddTableName = tables.find((t) => /LNCEL_FDD$/i.test(t) || /LNCEL_LNCEL_FDD$/i.test(t));

  // 3. Locate LNCEL_TDD table
  const tddTableName = tables.find((t) => /LNCEL_TDD$/i.test(t) || /LNCEL_LNCEL_TDD$/i.test(t));

  // 4. Locate PC table (for pMax)
  const pcTableName = tables.find((t) => /LNCEL_PC$/i.test(t));

  // 5. Locate neighbour handover relations (LNREL), keyed by lnRelId
  const lnrelTableName = tables.find((t) => /^A_/i.test(t) && /LNREL$/i.test(t));

  const processTable = (
    tableName: string | undefined,
    cls: string,
    suffix: string,
    isSecondary = false,
    idCol?: string,
    idPrefix?: string,
  ) => {
    if (!tableName) return;
    try {
      const table = reader.getTable(tableName);
      const cols = table.getColumnNames();

      const mrbtsCol = findCol(cols, ["mrbtsId", "mrbts"]);
      const btsCol = findCol(cols, ["lnBtsId", "btsId", "bts", "mrbtsId", "mrbts"]);
      const celCol = findCol(cols, ["lnCelId", "celId", "cel"]);
      const idColumn = idCol ? findCol(cols, [idCol]) : undefined;

      if (!mrbtsCol || !celCol) return;
      if (idCol && !idColumn) return;

      const paramCols = cols.filter(
        (c) => c !== mrbtsCol && c !== btsCol && c !== celCol && c !== idColumn && PARAM_NAME_SET.has(c),
      );
      if (paramCols.length === 0) return;

      const reqCols = [mrbtsCol, btsCol, celCol, idColumn, ...paramCols].filter(
        (c, i, arr): c is string => !!c && arr.indexOf(c) === i,
      );

      const rows = table.getData({ columns: reqCols });

      for (const r of rows) {
        const mrbts = parseInt(String(r[mrbtsCol]), 10);
        const bts =
          btsCol && r[btsCol] !== null && r[btsCol] !== undefined
            ? parseInt(String(r[btsCol]), 10)
            : mrbts;
        const cel = parseInt(String(r[celCol]), 10);
        if (isNaN(mrbts) || isNaN(cel)) continue;

        let dn = `PLMN-PLMN/MRBTS-${mrbts}/LNBTS-${bts}/LNCEL-${cel}${suffix}`;
        if (idColumn) {
          const idv = r[idColumn];
          if (idv === null || idv === undefined || idv === "") continue;
          dn += `/${idPrefix ?? ""}${String(idv)}`;
        }
        if (!isSecondary) into.scanned++;
        if (!wanted.has(dn)) continue;

        const obj: DbObject = into.objects.get(dn) ?? {
          cls,
          version: DEFAULT_VERSION,
          p: {},
        };

        for (const p of paramCols) {
          const val = r[p];
          if (val !== null && val !== undefined && val !== "") {
            obj.p[p] = String(val);
          }
        }
        into.objects.set(dn, obj);
      }
    } catch (e) {
      console.warn(`Error scanning MDB table ${tableName}:`, e);
    }
  };

  processTable(lncelTableName, "NOKLTE:LNCEL", "");
  processTable(pcTableName, "NOKLTE:LNCEL", "", true); // pMax merges into LNCEL
  processTable(fddTableName, "NOKLTE:LNCEL_FDD", "/LNCEL_FDD-0");
  processTable(tddTableName, "NOKLTE:LNCEL_TDD", "/LNCEL_TDD-0");
  processTable(lnrelTableName, "NOKLTE:LNREL", "", false, "lnRelId", "LNREL-");

  // NR (5G): the NRCELL managed object is split across many tables that all share the
  // (mrbtsId, nrBtsId, nrCellId) key. We read every NRCELL* table and merge any column that
  // matches a known NR parameter (either its name or its DB column, e.g. beamSet_tiltOffset).
  const nrParamByCol = new Map<string, string>();
  for (const [name, def] of Object.entries(NR_PARAMS)) {
    nrParamByCol.set(name, name);
    if (def.dbColumn) nrParamByCol.set(def.dbColumn, name);
  }

  const processNrTable = (tableName: string, isBase: boolean) => {
    try {
      const table = reader.getTable(tableName);
      const cols = table.getColumnNames();

      const mrbtsCol = findCol(cols, ["mrbtsId", "mrbts"]);
      const btsCol = findCol(cols, ["nrBtsId", "btsId", "bts", "mrbtsId", "mrbts"]);
      const celCol = findCol(cols, ["nrCellId", "celId", "cel"]);
      if (!mrbtsCol || !celCol) return;

      const mapped = cols
        .filter((c) => c !== mrbtsCol && c !== btsCol && c !== celCol && nrParamByCol.has(c))
        .map((c) => [c, nrParamByCol.get(c)!] as const);
      if (mapped.length === 0) return;

      const reqCols = [mrbtsCol, btsCol, celCol, ...mapped.map(([c]) => c)].filter(
        (c, i, arr): c is string => !!c && arr.indexOf(c) === i,
      );
      const rows = table.getData({ columns: reqCols });

      for (const r of rows) {
        const mrbts = parseInt(String(r[mrbtsCol]), 10);
        const bts = btsCol && r[btsCol] !== null && r[btsCol] !== undefined ? parseInt(String(r[btsCol]), 10) : mrbts;
        const cel = parseInt(String(r[celCol]), 10);
        if (isNaN(mrbts) || isNaN(bts) || isNaN(cel)) continue;

        if (isBase) into.scanned++;
        const dn = `PLMN-PLMN/MRBTS-${mrbts}/NRBTS-${bts}/NRCELL-${cel}`;
        if (!wanted.has(dn)) continue;

        const obj: DbObject = into.objects.get(dn) ?? {
          cls: "com.nokia.srbts.nrbts:NRCELL",
          version: DEFAULT_NR_VERSION,
          p: {},
        };
        for (const [col, param] of mapped) {
          const val = r[col];
          if (val !== null && val !== undefined && val !== "") obj.p[param] = String(val);
        }
        into.objects.set(dn, obj);
      }
    } catch (e) {
      console.warn(`Error scanning MDB table ${tableName}:`, e);
    }
  };

  let wantsNr = false;
  for (const d of wanted) {
    if (d.includes("/NRCELL-")) {
      wantsNr = true;
      break;
    }
  }
  if (wantsNr) {
    for (const t of tables) {
      if (!/NRCELL/i.test(t) || /NRADJNRCELL/i.test(t)) continue;
      // Skip sub-object tables that carry their own id column (e.g. NRDLMUMIMO) - their columns do
      // not map to base NRCELL parameters, so processNrTable simply returns without doing anything.
      processNrTable(t, /NRBTS_NRCELL$/i.test(t));
    }
  }
}

export async function loadDb(
  files: { name: string; data: Buffer; path?: string }[],
  wanted: Set<string>,
  wantedParams: Set<string> | null = null,
): Promise<DbLoad> {
  const into: DbLoad = { objects: new Map(), filesRead: 0, scanned: 0 };
  const scanSink = wanted.size > 0 ? makeScanSink(wanted, wantedParams, into) : null;

  const sinks: DbSinks = {
    xml: async (source) => {
      into.filesRead++;
      if (scanSink) await parseXmlStream(source, scanSink);
      // without a wanted set nothing is scanned, but a piped archive member must still be
      // consumed or the extractor process deadlocks on backpressure
      else for await (const _c of source) void _c;
    },
    mdb: (data) => {
      into.filesRead++;
      if (scanSink) scanMdb(data, wanted, into);
    },
  };

  for (const f of files) await ingest(f.name, f.data, sinks, 0, f.path);
  return into;
}
