import MDBReader from "mdb-reader";
import { DEFAULT_NR_VERSION, DEFAULT_VERSION, NR_PARAMS, PARAM_NAMES } from "./config";
import { ingest, kindOf, type DbSinks } from "./archive";
import { openFileBuffer } from "./fileBuffer";
import { releaseMemoryAfter } from "./mem";
import { makeScanSink, parseXmlStream, attrValue, type DbLoad, type DbObject, type XmlTagSink } from "./xmlscan";

export { kindOf, parseXmlStream, attrValue };
export type { Kind } from "./archive";
export type { DbObject, DbLoad, XmlTagSink } from "./xmlscan";

const PARAM_NAME_SET = new Set(PARAM_NAMES);

/** mdb-reader yields numbers for numeric columns and strings for text ones; both become ints. */
function toId(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") return parseInt(v, 10);
  if (typeof v === "bigint") return Number(v);
  return NaN;
}

/** Numeric key for (mrbts, cell) - cheap enough to check before building any distName string. */
const idKey = (mrbts: number, cel: number) => mrbts * 65536 + cel;

type IdPrefilter = {
  lncel: Set<number>;
  fdd: Set<number>;
  tdd: Set<number>;
  lnrel: Set<number>;
  nr: Set<number>;
};

const LTE_WANTED_RX = /^PLMN-PLMN\/MRBTS-(\d+)\/LNBTS-\d+\/LNCEL-(\d+)(?:\/(LNCEL_FDD|LNCEL_TDD|LNREL).*)?$/;
const NR_WANTED_RX = /^PLMN-PLMN\/MRBTS-(\d+)\/NRBTS-\d+\/NRCELL-(\d+)$/;

/**
 * A huge export is scanned row by row, but only a handful of cells are wanted. Parsing the wanted
 * distNames once into numeric keys lets the scan skip ~99% of the network before it formats a
 * single `PLMN-PLMN/...` string.
 */
function buildPrefilter(wanted: Set<string>): IdPrefilter {
  const out: IdPrefilter = { lncel: new Set(), fdd: new Set(), tdd: new Set(), lnrel: new Set(), nr: new Set() };
  for (const dn of wanted) {
    const nr = NR_WANTED_RX.exec(dn);
    if (nr) {
      out.nr.add(idKey(Number(nr[1]), Number(nr[2])));
      continue;
    }
    const lte = LTE_WANTED_RX.exec(dn);
    if (!lte) continue;
    const key = idKey(Number(lte[1]), Number(lte[2]));
    if (lte[3] === "LNCEL_FDD") out.fdd.add(key);
    else if (lte[3] === "LNCEL_TDD") out.tdd.add(key);
    else if (lte[3] === "LNREL") out.lnrel.add(key);
    else out.lncel.add(key);
  }
  return out;
}

function findCol(cols: string[], candidates: string[]): string | undefined {
  const lowerCols = cols.map((c) => c.toLowerCase());
  for (const cand of candidates) {
    const idx = lowerCols.indexOf(cand.toLowerCase());
    if (idx !== -1) return cols[idx];
  }
  return undefined;
}

/**
 * Scan an Access database (.mdb / .accdb) from disk.
 * Identifies LNCEL, LNCEL_FDD, LNCEL_TDD and LNCEL_PC tables, reads only requested parameter
 * columns, and maps them to distNames for fast in-memory diffing. The database stays on disk:
 * mdb-reader gets a file-backed buffer, so only the pages being read are in memory.
 */
function scanMdb(filePath: string, size: number, wanted: Set<string>, into: DbLoad) {
  const fileBuffer = openFileBuffer(filePath, size);
  try {
    scanMdbReader(new MDBReader(fileBuffer as unknown as Buffer), wanted, into);
  } finally {
    fileBuffer.close();
  }
}

function scanMdbReader(reader: MDBReader, wanted: Set<string>, into: DbLoad) {
  const pre = buildPrefilter(wanted);
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
    keys?: Set<number>,
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
        const mrbts = toId(r[mrbtsCol]);
        const cel = toId(r[celCol]);
        if (isNaN(mrbts) || isNaN(cel)) continue;
        if (!isSecondary) into.scanned++;
        // Skip rows that cannot match before formatting a single string.
        if (keys && !keys.has(idKey(mrbts, cel))) continue;

        const bts = btsCol && r[btsCol] !== null && r[btsCol] !== undefined ? toId(r[btsCol]) : mrbts;

        let dn = `PLMN-PLMN/MRBTS-${mrbts}/LNBTS-${bts}/LNCEL-${cel}${suffix}`;
        if (idColumn) {
          const idv = r[idColumn];
          if (idv === null || idv === undefined || idv === "") continue;
          dn += `/${idPrefix ?? ""}${String(idv)}`;
        }
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

  processTable(lncelTableName, "NOKLTE:LNCEL", "", false, undefined, undefined, pre.lncel);
  processTable(pcTableName, "NOKLTE:LNCEL", "", true, undefined, undefined, pre.lncel); // pMax merges into LNCEL
  processTable(fddTableName, "NOKLTE:LNCEL_FDD", "/LNCEL_FDD-0", false, undefined, undefined, pre.fdd);
  processTable(tddTableName, "NOKLTE:LNCEL_TDD", "/LNCEL_TDD-0", false, undefined, undefined, pre.tdd);
  processTable(lnrelTableName, "NOKLTE:LNREL", "", false, "lnRelId", "LNREL-", pre.lnrel);

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
        const mrbts = toId(r[mrbtsCol]);
        const bts = btsCol && r[btsCol] !== null && r[btsCol] !== undefined ? toId(r[btsCol]) : mrbts;
        const cel = toId(r[celCol]);
        if (isNaN(mrbts) || isNaN(bts) || isNaN(cel)) continue;

        if (isBase) into.scanned++;
        if (!pre.nr.has(idKey(mrbts, cel))) continue;
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
  files: { name: string; data: Buffer; path?: string; bytes?: number }[],
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
    mdb: (path, _name, size) => {
      into.filesRead++;
      if (scanSink) scanMdb(path, size, wanted, into);
    },
  };

  for (const f of files) {
    await ingest(f.name, f.data, sinks, 0, f.path);
    releaseMemoryAfter(f.bytes ?? f.data.length); // one big scan's buffers shouldn't stack onto the next
  }
  return into;
}
