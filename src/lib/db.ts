import JSZip from "jszip";
import { gunzipSync } from "node:zlib";
import { createExtractorFromData } from "node-unrar-js";
import MDBReader from "mdb-reader";
import {
  DEFAULT_NR_VERSION,
  DEFAULT_VERSION,
  NR_PARAMS,
  PARAM_NAMES,
  paramNamesFor,
  type ParamDef,
} from "./config";

export type DbObject = { cls: string; version: string; p: Record<string, string> };

export type DbLoad = {
  objects: Map<string, DbObject>;
  filesRead: number;
  scanned: number;
};

/** XML-unescape, but skip the five regex passes entirely when there is nothing to unescape. */
function decode(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * XML-decoded value of one attribute inside an element's attribute string.
 * Hand-rolled indexOf scan (no regex) - this runs once per managed object, so it matters.
 */
function attrValue(s: string, name: string): string | undefined {
  const len = name.length;
  for (let idx = s.indexOf(name); idx !== -1; idx = s.indexOf(name, idx + 1)) {
    const before = idx === 0 ? 32 : s.charCodeAt(idx - 1);
    if (!isSpace(before)) continue;
    let j = idx + len;
    let c = s.charCodeAt(j);
    while (isSpace(c)) c = s.charCodeAt(++j);
    if (c !== 61) continue; // '='
    c = s.charCodeAt(++j);
    while (isSpace(c)) c = s.charCodeAt(++j);
    if (c !== 34 && c !== 39) continue; // " or '
    const end = s.indexOf(c === 34 ? '"' : "'", j + 1);
    if (end !== -1) return decode(s.slice(j + 1, end));
  }
  return undefined;
}

/** Parse the <p name="...">value</p> children of a managed object we actually keep. */
function scanParams(data: Buffer, start: number, end: number, obj: DbObject) {
  let i = start;
  while (i < end) {
    const p = data.indexOf("<p", i, "latin1");
    if (p === -1 || p >= end) break;
    if (!isSpace(data[p + 2])) {
      i = p + 2;
      continue;
    }
    const gt = data.indexOf(">", p + 3, "latin1");
    if (gt === -1 || gt >= end) break;
    if (data[gt - 1] === 47) {
      i = gt + 1; // self-closing <p .../>
      continue;
    }
    const name = attrValue(data.toString("utf8", p + 3, gt), "name");
    const close = data.indexOf("</p>", gt + 1, "latin1");
    if (close === -1 || close >= end) break;
    if (name) obj.p[name] = decode(data.toString("utf8", gt + 1, close)).trim();
    i = close + 4;
  }
}

/**
 * Scan one RAML document straight from its bytes, keyed off `distName="` occurrences.
 *
 * Only objects whose distName is in `wanted` are kept, so a huge network export does not blow up
 * memory. Because the wanted set is built from LTE cell distNames, it already filters by class -
 * there is no need to parse the `class` attribute, and no need to visit objects we cannot use.
 *
 * Each accepted object costs a single native `indexOf` (to find the next distName); the closing
 * quote is found with a plain byte scan, which is far cheaper than another native call. Attribute
 * parsing (version) and body parsing happen only for objects that survive the wanted filter, which
 * is a tiny fraction of a network export.
 */
function scanXml(data: Buffer, wanted: Set<string>, into: DbLoad) {
  const KEY = 'distName="';
  const klen = KEY.length;
  const len = data.length;

  // FNV-1a of each wanted distName. Comparing a rolled-up 32-bit hash avoids allocating a string
  // for every one of the (potentially millions of) objects in the export - only the handful whose
  // hash collides gets decoded, and those are re-checked against the set so collisions are harmless.
  const hashes = new Set<number>();
  for (const dn of wanted) {
    const b = Buffer.from(dn, "utf8");
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193);
    }
    hashes.add(h);
  }

  let p = data.indexOf(KEY, 0);
  while (p !== -1) {
    const vs = p + klen;
    let ve = vs;
    while (ve < len && data[ve] !== 34) ve++; // '"'
    if (ve >= len) break;

    const next = data.indexOf(KEY, ve);

    // One pass over the distName bytes: hash it (for the wanted lookup) and note whether it is an
    // LTE cell (for the stat). Only the handful of objects whose hash collides is decoded, and those
    // are re-checked against the set, so a collision can never produce a wrong match.
    let h = 0x811c9dc5;
    let hasLncel = false;
    let hasNrcell = false;
    for (let i = vs; i < ve; i++) {
      const b = data[i];
      h ^= b;
      h = Math.imul(h, 0x01000193);
      if (b === 47 && data[i + 1] === 76 && data[i + 2] === 78 && data[i + 3] === 67 && data[i + 4] === 69 && data[i + 5] === 76) {
        hasLncel = true; // "/LNCEL"
      }
      if (b === 47 && data[i + 1] === 78 && data[i + 2] === 82 && data[i + 3] === 67 && data[i + 4] === 69 && data[i + 5] === 76 && data[i + 6] === 76) {
        hasNrcell = true; // "/NRCELL"
      }
    }
    if (hasLncel || hasNrcell) into.scanned++;

    if (hashes.has(h)) {
      const dn = data.toString("utf8", vs, ve);
      if (wanted.has(dn)) {
        const open = data.lastIndexOf("<managedObject", p);
        const tagStart = open < 0 ? vs : open + 13;
        const gt = data.indexOf(">", ve);
        if (gt !== -1) {
          const selfClose = data[gt - 1] === 47; // '/'
          const tag = data.toString("latin1", tagStart, selfClose ? gt - 1 : gt);
          let cls = "NOKLTE:LNCEL";
          if (dn.endsWith("/LNCEL_FDD-0")) cls = "NOKLTE:LNCEL_FDD";
          else if (dn.endsWith("/LNCEL_TDD-0")) cls = "NOKLTE:LNCEL_TDD";
          else if (dn.includes("/LNREL-")) cls = "NOKLTE:LNREL";
          else if (dn.includes("/NRCELL-")) cls = "com.nokia.srbts.nrbts:NRCELL";
          const version = attrValue(tag, "version");
          const obj = into.objects.get(dn) ?? { cls, version: "", p: {} };
          if (version) obj.version = version;
          if (!selfClose) {
            const bodyStart = gt + 1;
            const bodyEnd = next === -1 ? len : data.lastIndexOf("<managedObject", next);
            if (bodyEnd > bodyStart) scanParams(data, bodyStart, bodyEnd, obj);
          }
          into.objects.set(dn, obj);
        }
      }
    }
    p = next;
  }
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
        (c) => c !== mrbtsCol && c !== btsCol && c !== celCol && c !== idColumn && PARAM_NAMES.includes(c),
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

  const wantsNr = [...wanted].some((d) => d.includes("/NRCELL-"));
  if (wantsNr) {
    for (const t of tables) {
      if (!/NRCELL/i.test(t) || /NRADJNRCELL/i.test(t)) continue;
      // Skip sub-object tables that carry their own id column (e.g. NRDLMUMIMO) - their columns do
      // not map to base NRCELL parameters, so processNrTable simply returns without doing anything.
      processNrTable(t, /NRBTS_NRCELL$/i.test(t));
    }
  }
}

type Kind = "xml" | "gz" | "zip" | "rar" | "mdb" | null;

/** Magic bytes first (links often have no usable file name), extension as a fallback. */
export function kindOf(name: string, d: Buffer): Kind {
  if (d.length > 6 && d.subarray(0, 4).toString("latin1") === "Rar!") return "rar";
  if (d.length > 3 && d[0] === 0x50 && d[1] === 0x4b && (d[2] === 3 || d[2] === 5)) return "zip";
  if (d.length > 2 && d[0] === 0x1f && d[1] === 0x8b) return "gz";
  if (
    d.length > 20 &&
    (d.subarray(4, 19).toString("latin1") === "Standard Jet DB" ||
      d.subarray(4, 19).toString("latin1") === "Standard ACE DB")
  ) {
    return "mdb";
  }
  const head = d.subarray(0, 64).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<")) return "xml";
  const l = name.toLowerCase();
  if (l.endsWith(".xml")) return "xml";
  if (l.endsWith(".gz")) return "gz";
  if (l.endsWith(".zip")) return "zip";
  if (l.endsWith(".rar")) return "rar";
  if (l.endsWith(".mdb") || l.endsWith(".accdb")) return "mdb";
  return null;
}

/** Handles xml, mdb, gz, zip and rar - including archives nested inside archives. */
async function ingest(name: string, data: Buffer, wanted: Set<string>, into: DbLoad, depth = 0): Promise<void> {
  if (depth > 4) return;
  const kind = kindOf(name, data);

  if (kind === "xml") {
    into.filesRead++;
    if (wanted.size > 0) scanXml(data, wanted, into);
  } else if (kind === "mdb") {
    into.filesRead++;
    if (wanted.size > 0) scanMdb(data, wanted, into);
  } else if (kind === "gz") {
    await ingest(name.replace(/\.gz$/i, ""), gunzipSync(data), wanted, into, depth + 1);
  } else if (kind === "zip") {
    const zip = await JSZip.loadAsync(data);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      await ingest(entry.name, Buffer.from(await entry.async("uint8array")), wanted, into, depth + 1);
    }
  } else if (kind === "rar") {
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    try {
      const extractor = await createExtractorFromData({ data: ab });
      const { files } = extractor.extract({ files: (h) => /\.(xml|zip|gz|rar|mdb|accdb)$/i.test(h.name) });
      for (const f of files) {
        if (f.fileHeader.flags.directory || !f.extraction) continue;
        await ingest(f.fileHeader.name, Buffer.from(f.extraction), wanted, into, depth + 1);
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Could not read "${name}" (${why}). It may be corrupt, password-protected or one part of a multi-volume RAR - ` +
          `try extracting it and uploading the .mdb or .xml files or a .zip instead.`,
      );
    }
  }
  // anything else (readme, csv, ...) is ignored
}

export async function loadDb(files: { name: string; data: Buffer }[], wanted: Set<string>): Promise<DbLoad> {
  const into: DbLoad = { objects: new Map(), filesRead: 0, scanned: 0 };
  for (const f of files) await ingest(f.name, f.data, wanted, into);
  return into;
}
