import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import MDBReader from "mdb-reader";
import { openFileBuffer } from "./fileBuffer";
import { attrValue, parseXmlStream, type XmlTagSink } from "./xmlscan";

/**
 * Create a NetAct dump (.mdb) from a RAML XML export.
 *
 * The empty dump carries the import metadata: IMPORT_CLASS_FILTER maps a RAML class to the class
 * name used by the database and gives its distName format + id parameters; IMPORT_LIST_MAPPING
 * describes nested lists (a child table, or columns flattened onto the parent).  Tables are named
 * `A_<class>`; child rows repeat the parent ids and append `listId`.
 *
 * Rows are streamed to the Java Jackcess helper (tools/mdb-fill), the only MDB writer that runs on
 * Linux. Values are raw UTF-8, escaped so tabs/newlines/backslashes inside names cannot break the
 * line protocol (an empty value is `!`, a literal `!` is `\!`, unset columns are omitted):
 *
 *   H <id> <table> <col1> <col2> ...   declare a table's column order (once)
 *   R <id> <i>:<v> <i>:<v> ...         one row; i is the column index
 *   E                                  end of input
 */

export type FillCol = { name: string; type: string; size: number };
export type FillTable = { name: string; cols: FillCol[]; byLower: Map<string, FillCol>; index: Map<string, number> };

type ChildList = {
  kind: "child";
  table: FillTable;
  ids: { col: number; key: string }[];
  listIdCol: number | null;
  values: Map<string, number>;
  flatValueCol: number | null;
  meta: MetaCols;
};

/** A mapping_type=2 list: its items are flattened into columns of (another) table. */
export type FlatList = {
  table: FillTable;
  /** the destination class rule - any object whose distName matches is a candidate */
  re: RegExp;
  ids: { col: number; key: string }[];
  /** lower-case item parameter (and every suffix) -> destination column */
  values: Map<string, number>;
  /** for lists of plain scalar values, the single destination column */
  flatValueCol: number | null;
  meta: MetaCols;
};

/**
 * A parent parameter that the database stores in a same-distName block table (e.g. LNCEL's
 * a3Offset lives in A_LTE_LNCEL_HC, NRCELL's numOfSubSectors in A_NRBTS_NRCELL_SCH).
 */
export type FlatParam = {
  table: FillTable;
  re: RegExp;
  ids: { col: number; key: string }[];
  col: number;
  meta: MetaCols;
};

type MetaCols = { status: number | null; modified: number | null; imported: number | null };
export type FillRow = { table: FillTable; values: Map<number, string | number>; meta: MetaCols };

/** A same-distName block table: NetAct writes one row per parent object, even when empty. */
export type BlockTable = { table: FillTable; ids: { col: number; key: string }[]; meta: MetaCols };

export type FillClass = {
  dbClass: string;
  table: FillTable;
  ids: { col: number; key: string }[];
  /** captures the distName id values (handles several ids inside one segment, e.g. ADCE-%5d%d) */
  idRe: RegExp;
  /** capture-group offset when the format's first group is the PLMN and not an id column */
  idOffset: number;
  /** lower-case XML parameter -> table column index */
  cols: Map<string, number>;
  /** runtime cache: XML parameter -> column index (false = known unmapped) */
  paramLookup: Map<string, number | false>;
  /** runtime cache: XML parameter -> flattened destinations (false = none) */
  flatParamLookup: Map<string, FlatParam[] | false>;
  lists: Map<string, ChildList>;
  /** type-1 lists with a single value column (for name drift between export versions) */
  scalarLists: ChildList[];
  /** other A_<class> tables sharing this class's distName format */
  blocks: BlockTable[];
  meta: MetaCols;
};

type ClassRule = { dbClass: string; re: RegExp; ids: string[] };

export type FillSchema = {
  tableNames: Set<string>;
  rules: Map<string, ClassRule[]>;
  /** db class -> resolved table rules */
  classes: Map<string, FillClass | null>;
  /** lower-case list name -> flattened destinations, matched by distName shape */
  flat: Map<string, FlatList[]>;
  /** lower-case XML parameter -> same-distName block tables (matched by distName shape) */
  flatParams: Map<string, FlatParam[]>;
  /** resolution cache: "<xmlClass>\n<dnShape>" -> class (or null) */
  cache: Map<string, FillClass | null>;
  /** XML class with a single possible destination class - no distName-shape lookup needed */
  simple: Map<string, { cls: FillClass | null; re: RegExp }>;
  stats: { classes: number; lists: number };
};

const META = new Set(["template_name", "template_set", "status", "last_modified", "last_actual_import"]);
const lower = (s: string) => s.toLowerCase();

const asRows = (reader: MDBReader, name: string): Record<string, unknown>[] =>
  reader.getTable(name).getData() as unknown as Record<string, unknown>[];

const asTable = (reader: MDBReader, name: string): FillTable => {
  const t = reader.getTable(name);
  const cols: FillCol[] = (t.getColumns() as unknown as FillCol[]).map((c) => ({ name: c.name, type: c.type, size: c.size }));
  return {
    name,
    cols,
    byLower: new Map(cols.map((c) => [lower(c.name), c])),
    index: new Map(cols.map((c, i) => [lower(c.name), i])),
  };
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `PLMN-PLMN/MRBTS-%d/LNBTS-%d` -> /^PLMN-PLMN\/MRBTS-[^/]+\/LNBTS-[^/]+$/ */
const compileDnFormat = (format: string) => new RegExp("^" + escapeRe(format).replace(/%[0-9]*[dsi]/g, "[^/]+") + "$", "i");

/** Same format, but every placeholder becomes a capture (`%5d%d` -> two groups in one segment). */
const compileDnCapture = (format: string): { re: RegExp; count: number } => {
  let out = "";
  let count = 0;
  for (let i = 0; i < format.length; i++) {
    if (format[i] === "%") {
      const m = /^%([0-9]*)([dsi])/.exec(format.slice(i));
      if (m) {
        const width = Number(m[1] || 0);
        out += m[2] === "s" ? "([^/]+)" : `(\\d${width ? `{${width}}` : "+"})`;
        count++;
        i += m[0].length - 1;
        continue;
      }
    }
    out += escapeRe(format[i]);
  }
  return { re: new RegExp("^" + out + "$", "i"), count };
};

/** Raw `raml2_dn_parameters` (a leading empty entry stands for the PLMN component). */
const splitParams = (s: unknown): string[] => String(s ?? "").split(",").map((x) => x.trim());

const splitList = (s: unknown): string[] =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** XML item params omit the mapping prefix (`pCA_csiReportPeriodicity` <- `csiReportPeriodicity`). */
const suffixKeys = (target: string): string[] => {
  const keys = [lower(target)];
  for (let i = 0; i < target.length; i++) if (target[i] === "_") keys.push(lower(target.slice(i + 1)));
  return keys;
};

function metaOf(table: FillTable): MetaCols {
  return {
    status: table.index.get("status") ?? null,
    modified: table.index.get("last_modified") ?? null,
    imported: table.index.get("last_actual_import") ?? null,
  };
}

/** Builds the class -> table/list rules from the (empty) template database. */
export function buildFillSchema(dbPath: string): FillSchema {
  const size = fs.statSync(dbPath).size;
  const buf = openFileBuffer(dbPath, size);
  const reader = new MDBReader(buf as unknown as Buffer);
  try {
    const names = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
    const tableNames = new Set(names);
    const tables = new Map<string, FillTable>();

    const table = (name: string): FillTable | null => {
      const hit = tables.get(name);
      if (hit) return hit;
      if (!tableNames.has(name)) return null;
      const t = asTable(reader, name);
      tables.set(name, t);
      return t;
    };

    // OSS rows describe the RAML export; the other filter sets (Generic/SCF/NAdC) are used by
    // other importers.  They are kept as a fallback (e.g. NMS only has a Generic row) but OSS
    // must win when several rows describe the same distName shape.
    const filters = asRows(reader, "IMPORT_CLASS_FILTER").filter(
      (r) => r.raml2_dn_format && r.class && r.raml2_dn_parameters,
    );
    filters.sort((a, b) => Number(b.class_filter_name === "OSS") - Number(a.class_filter_name === "OSS"));
    const filterByClass = new Map<string, Record<string, unknown>>();
    for (const r of filters) if (!filterByClass.has(String(r.class))) filterByClass.set(String(r.class), r);

    // Block tables share their parent's exact OSS distName format; NetAct creates one row per
    // parent object in each of them (LNCEL alone has 13).
    const ossFormat = new Map<string, string>();
    const byFormat = new Map<string, string[]>();
    for (const r of filters) {
      if (r.class_filter_name !== "OSS" || !r.raml2_dn_format) continue;
      const c = String(r.class);
      if (ossFormat.has(c)) continue;
      const f = lower(String(r.raml2_dn_format));
      ossFormat.set(c, f);
      const arr = byFormat.get(f);
      if (arr) arr.push(c);
      else byFormat.set(f, [c]);
    }

    // XML class -> candidate rules.  A db class ends with _<xml class> (the class can be
    // multi-token, e.g. LNCEL_FDD), so index every trailing suffix.
    const rules = new Map<string, ClassRule[]>();
    const ossRules = new Map<string, ClassRule>();
    const ruleByClass = new Map<string, ClassRule>();
    const addRule = (key: string, rule: ClassRule) => {
      const list = rules.get(key);
      if (!list) {
        rules.set(key, [rule]);
        return;
      }
      if (!list.some((x) => x.dbClass === rule.dbClass)) list.push(rule);
    };
    for (const r of filters) {
      const dbClass = String(r.class);
      const rule: ClassRule = {
        dbClass,
        re: compileDnFormat(String(r.raml2_dn_format)),
        ids: splitList(r.raml2_dn_parameters),
      };
      if (!ossRules.has(dbClass)) ossRules.set(dbClass, rule);
      if (!ruleByClass.has(dbClass)) ruleByClass.set(dbClass, rule);
      const parts = dbClass.split("_");
      for (let i = parts.length - 1; i >= 0; i--) addRule(lower(parts.slice(i).join("_")), rule);
    }

    const listRows = asRows(reader, "IMPORT_LIST_MAPPING").filter((r) => r.list_mapping_name === "OSS");
    const listsByClass = new Map<string, Record<string, unknown>[]>();
    for (const r of listRows) {
      const k = String(r.class);
      const arr = listsByClass.get(k);
      if (arr) arr.push(r);
      else listsByClass.set(k, [r]);
    }

    const classes = new Map<string, FillClass | null>();
    let listCount = 0;
    for (const dbClass of filterByClass.keys()) {
      const filter = filterByClass.get(dbClass)!;
      const t = table(`A_${dbClass}`);
      if (!t) {
        classes.set(dbClass, null);
        continue;
      }
      const capture = compileDnCapture(String(filter.raml2_dn_format));
      let idNames = splitParams(filter.raml2_dn_parameters);
      let idOffset = 0;
      if (idNames[0] === "") {
        idNames = idNames.slice(1);
        // e.g. ADCE: OSS format has 5 placeholders (last one is `%5d%d`) for the 5 id columns.
        idOffset = Math.max(0, capture.count - idNames.length);
      }
      if (capture.count !== idNames.length + idOffset) {
        // Unknown layout: keep the old one-id-per-segment behaviour instead of dropping the class.
        idNames = splitList(filter.raml2_dn_parameters);
        idOffset = 0;
      }
      const ids = idNames.flatMap((k) => {
        const col = t.index.get(lower(k));
        return col === undefined ? [] : [{ col, key: lower(k) }];
      });
      if (ids.length !== idNames.length) {
        classes.set(dbClass, null);
        continue;
      }

      const cols = new Map<string, number>();
      for (let i = 0; i < t.cols.length; i++) {
        if (!META.has(lower(t.cols[i].name))) cols.set(lower(t.cols[i].name), i);
      }

      const lists = new Map<string, ChildList>();
      const scalarLists: ChildList[] = [];
      for (const r of listsByClass.get(dbClass) ?? []) {
        if (Number(r.mapping_type) !== 1 || !r.child_class) continue;
        const name = String(r.list);
        const child = table(`A_${r.child_class}`);
        if (!child) continue;
        const keyCols = new Set(ids.map((i) => lower(t.cols[i.col].name)));
        const listId = child.index.get("listid") ?? null;
        if (listId !== null) keyCols.add("listid");
        const values = new Map<string, number>();
        for (let i = 0; i < child.cols.length; i++) {
          const lc = lower(child.cols[i].name);
          if (keyCols.has(lc) || META.has(lc)) continue;
          values.set(lc, i);
        }
        const flatValueCol = values.size === 1 ? [...values.values()][0] : (values.get(lower(name)) ?? null);
        const plan: ChildList = {
          kind: "child",
          table: child,
          ids: ids.map((i) => ({ col: child.index.get(lower(t.cols[i.col].name))!, key: i.key })),
          listIdCol: listId,
          values,
          flatValueCol,
          meta: metaOf(child),
        };
        lists.set(lower(name), plan);
        if (flatValueCol !== null) scalarLists.push(plan);
        listCount++;
      }

      const blocks: BlockTable[] = [];
      const format = ossFormat.get(dbClass);
      for (const blockClass of (format && byFormat.get(format)) || []) {
        if (blockClass === dbClass) continue;
        const bt = table(`A_${blockClass}`);
        const brule = ruleByClass.get(blockClass);
        if (!bt || !brule) continue;
        const blockIds = brule.ids.flatMap((k) => {
          const col = bt.index.get(lower(k));
          return col === undefined ? [] : [{ col, key: lower(k) }];
        });
        if (blockIds.length !== brule.ids.length) continue;
        blocks.push({ table: bt, ids: blockIds, meta: metaOf(bt) });
      }

      classes.set(dbClass, {
        dbClass,
        table: t,
        ids,
        idRe: capture.re,
        idOffset,
        cols,
        paramLookup: new Map(),
        flatParamLookup: new Map(),
        lists,
        scalarLists,
        blocks,
        meta: metaOf(t),
      });
    }

    // mapping_type=2 lists live in A_<class> tables (often the parent's own table, sometimes a
    // dedicated block such as NRBTS_NRCELL_SCH).  They are matched by distName, because the
    // mapping class is not the XML class.
    const flat = new Map<string, FlatList[]>();
    for (const r of listRows) {
      if (Number(r.mapping_type) !== 2 || !r.parameter_prefix_list) continue;
      const dbClass = String(r.class);
      const rule = ossRules.get(dbClass);
      const dest = table(`A_${dbClass}`);
      if (!rule || !dest) continue;
      const ids = rule.ids.flatMap((k) => {
        const col = dest.index.get(lower(k));
        return col === undefined ? [] : [{ col, key: lower(k) }];
      });
      if (ids.length !== rule.ids.length) continue;
      const values = new Map<string, number>();
      for (const target of splitList(r.parameter_prefix_list)) {
        const col = dest.index.get(lower(target));
        if (col === undefined) continue;
        for (const key of suffixKeys(target)) if (!values.has(key)) values.set(key, col);
      }
      if (!values.size) continue;
      const name = String(r.list);
      const destCols = new Set(values.values());
      const flatValueCol = destCols.size === 1 ? [...destCols][0] : (values.get(lower(name)) ?? null);
      const plan: FlatList = { table: dest, re: rule.re, ids, values, flatValueCol, meta: metaOf(dest) };
      const arr = flat.get(lower(name));
      if (arr) arr.push(plan);
      else flat.set(lower(name), [plan]);
      listCount++;
    }

    // Some parent parameters are stored in a block table that shares the parent's distName
    // (LNCEL's a3Offset -> A_LTE_LNCEL_HC, NRCELL's numOfSubSectors -> A_NRBTS_NRCELL_SCH).
    // IMPORT_PARAMETER_FILTER (OSS profile) names that destination class and column.
    const flatParams = new Map<string, FlatParam[]>();
    const pfByClass = new Map<string, Record<string, unknown>[]>();
    for (const r of asRows(reader, "IMPORT_PARAMETER_FILTER")) {
      if (!r.parameter || !r.class || r.parameter_filter_name !== "OSS") continue;
      const k = String(r.class);
      const arr = pfByClass.get(k);
      if (arr) arr.push(r);
      else pfByClass.set(k, [r]);
    }
    for (const [dbClass, rows] of pfByClass) {
      const rule = ruleByClass.get(dbClass);
      const dest = table(`A_${dbClass}`);
      if (!rule || !dest) continue;
      const ids = rule.ids.flatMap((k) => {
        const col = dest.index.get(lower(k));
        return col === undefined ? [] : [{ col, key: lower(k) }];
      });
      if (ids.length !== rule.ids.length) continue;
      const meta = metaOf(dest);
      for (const r of rows) {
        const col = dest.index.get(lower(String(r.parameter)));
        if (col === undefined) continue;
        const xmlName = lower(String(r.external_name ?? r.parameter));
        const plan: FlatParam = { table: dest, re: rule.re, ids, col, meta };
        const arr = flatParams.get(xmlName);
        if (arr) arr.push(plan);
        else flatParams.set(xmlName, [plan]);
      }
    }

    const simple = new Map<string, { cls: FillClass | null; re: RegExp }>();
    for (const [key, list] of rules) {
      const first = list[0];
      if (first && list.every((rule) => rule.dbClass === first.dbClass)) {
        simple.set(key, { cls: classes.get(first.dbClass) ?? null, re: first.re });
      }
    }

    return {
      tableNames,
      rules,
      classes,
      flat,
      flatParams,
      cache: new Map<string, FillClass | null>(),
      simple,
      stats: { classes: classes.size, lists: listCount },
    };
  } finally {
    buf.close();
  }
}

/** distName shape without instance ids - one class resolution per shape, not per object. */
function dnShape(dn: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i <= dn.length; i++) {
    if (i === dn.length || dn.charCodeAt(i) === 47) {
      const dash = dn.indexOf("-", start);
      const end = dash !== -1 && dash < i ? dash : i;
      if (start > 0) out += "/";
      out += dn.slice(start, end);
      start = i + 1;
    }
  }
  return out;
}

export type Resolved = { cls: FillClass; dn: string; values: string[] };

function idsFor(cls: FillClass, dn: string): Resolved | null {
  const m = cls.idRe.exec(dn);
  if (m) {
    const values = m.slice(1 + cls.idOffset);
    if (values.length === cls.ids.length) return { cls, dn, values };
  }
  // Fallback for formats whose DN has a PLMN prefix that is not part of the format.
  const segs = dn.split("/");
  const off = segs[0]?.startsWith("PLMN-") ? 1 : 0;
  if (segs.length - off !== cls.ids.length) return null;
  const values = new Array<string>(cls.ids.length);
  for (let i = 0; i < values.length; i++) {
    const s = segs[off + i];
    const dash = s.indexOf("-");
    values[i] = dash === -1 ? s : s.slice(dash + 1);
  }
  return { cls, dn, values };
}

function idsForExact(cls: FillClass, dn: string): Resolved | null {
  const m = cls.idRe.exec(dn);
  if (!m) return null;
  const values = m.slice(1 + cls.idOffset);
  return values.length === cls.ids.length ? { cls, dn, values } : null;
}

/** Resolve a managed object (class + distName) to its table and id values. */
export function resolveClass(schema: FillSchema, xmlClass: string, dn: string): Resolved | null {
  const simple = schema.simple.get(lower(xmlClass));
  if (simple !== undefined) {
    if (!simple.cls || !simple.re.test(dn)) return null;
    return idsForExact(simple.cls, dn) ?? idsFor(simple.cls, dn);
  }

  const key = `${xmlClass}\n${dnShape(dn)}`;
  const hit = schema.cache.get(key);
  if (hit !== undefined) return hit ? idsFor(hit, dn) : null;

  let chosen: FillClass | null = null;
  let fallback: FillClass | null = null;
  for (const rule of schema.rules.get(lower(xmlClass)) ?? []) {
    if (!rule.re.test(dn)) continue;
    const cls = schema.classes.get(rule.dbClass);
    if (!cls) continue;
    if (dn.startsWith("PLMN-PLMN/")) chosen = cls;
    else fallback = cls;
    if (chosen) break;
  }
  const cls = chosen ?? fallback;
  schema.cache.set(key, cls);
  return cls ? idsFor(cls, dn) : null;
}

export type ObjectLists = Map<string, { items: [string | null, string][][]; scalars: string[] }>;

function decodeText(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const attrSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** Value of the `name` attribute in [from,to), without allocating the tag slice. */
function rangeAttr(s: string, from: number, to: number): string | undefined {
  for (let i = s.indexOf("name", from); i !== -1 && i < to; i = s.indexOf("name", i + 4)) {
    if (i !== from && !attrSpace(s.charCodeAt(i - 1))) continue;
    let j = i + 4;
    let c = s.charCodeAt(j);
    while (attrSpace(c)) c = s.charCodeAt(++j);
    if (c !== 61) continue;
    c = s.charCodeAt(++j);
    while (attrSpace(c)) c = s.charCodeAt(++j);
    if (c !== 34 && c !== 39) continue;
    const end = s.indexOf(c === 34 ? '"' : "'", j + 1);
    if (end !== -1 && end <= to) return decodeText(s.slice(j + 1, end));
  }
  return undefined;
}

/** Parses the <p> children inside [from,to) of a list item (stops at a nested list). */
function parseP(block: string, from: number, to: number, out: [string | null, string][]) {
  let p = block.indexOf("<p", from);
  let l = block.indexOf("<list", from);
  while (p !== -1 && p < to) {
    if (l !== -1 && l < p) return;
    let gt: number;
    const c = block.charCodeAt(p + 2);
    if (c === 62) gt = p + 2; // <p> - a plain scalar value
    else if (attrSpace(c)) gt = block.indexOf(">", p + 3);
    else {
      p = block.indexOf("<p", p + 2);
      continue;
    }
    if (gt === -1 || gt >= to) return;
    if (block[gt - 1] === "/") {
      p = block.indexOf("<p", gt + 1);
      if (l !== -1 && l < gt + 1) l = block.indexOf("<list", gt + 1);
      continue;
    }
    const close = block.indexOf("</p>", gt + 1);
    if (close === -1 || close >= to) return;
    const name = gt === p + 2 ? null : (rangeAttr(block, p + 3, gt) ?? null);
    out.push([name, decodeText(block.slice(gt + 1, close)).trim()]);
    p = block.indexOf("<p", close + 4);
    if (l !== -1 && l < close + 4) l = block.indexOf("<list", close + 4);
  }
}

function findListClose(s: string, start: number): number {
  let depth = 1;
  let i = start;
  for (;;) {
    const open = s.indexOf("<list", i);
    const close = s.indexOf("</list>", i);
    if (close === -1) return -1;
    if (open !== -1 && open < close) {
      depth++;
      i = open + 5;
    } else {
      depth--;
      if (depth === 0) return close;
      i = close + 7;
    }
  }
}

export type ObjectBody = { params: string[]; lists: ObjectLists };

/** Parses one managed-object body: flat <p> params + top-level <list> blocks. */
export function parseManagedObjectBody(body: Buffer): ObjectBody {
  const s = body.toString("utf8");
  const params: string[] = [];
  const lists: ObjectLists = new Map();
  let p = s.indexOf("<p ");
  let l = s.indexOf("<list ");
  let i = 0;
  while (p !== -1 || l !== -1) {
    if (l === -1 || (p !== -1 && p < l)) {
      const gt = s.indexOf(">", p + 3);
      if (gt === -1) break;
      if (s[gt - 1] === "/") {
        i = gt + 1;
        p = s.indexOf("<p ", i);
        if (l !== -1 && l < i) l = s.indexOf("<list ", i);
        continue;
      }
      const close = s.indexOf("</p>", gt + 1);
      if (close === -1) break;
      const name = rangeAttr(s, p + 3, gt);
      if (name) params.push(name, decodeText(s.slice(gt + 1, close)).trim());
      i = close + 4;
      p = s.indexOf("<p ", i);
      if (l !== -1 && l < i) l = s.indexOf("<list ", i);
    } else {
      const gt = s.indexOf(">", l + 6);
      if (gt === -1) break;
      const name = rangeAttr(s, l + 6, gt);
      const close = findListClose(s, gt + 1);
      if (close === -1) break;
      const block = s.slice(gt + 1, close);
      const items: [string | null, string][][] = [];
      let j = 0;
      for (;;) {
        const it = block.indexOf("<item>", j);
        if (it === -1) break;
        const end = block.indexOf("</item>", it + 6);
        if (end === -1) break;
        const item: [string | null, string][] = [];
        parseP(block, it + 6, end, item);
        items.push(item);
        j = end + 7;
      }
      let scalars: string[] = [];
      if (items.length === 0) {
        const direct: [string | null, string][] = [];
        parseP(block, 0, block.length, direct);
        scalars = direct.map(([, v]) => v);
      }
      if (name) lists.set(name, { items, scalars });
      i = close + 7;
      l = s.indexOf("<list ", i);
      if (p !== -1 && p < i) p = s.indexOf("<p ", i);
    }
  }
  return { params, lists };
}

export type FillStats = {
  objects: number;
  parentRows: number;
  childRows: number;
  skippedClass: Map<string, number>;
  unknownParams: Map<string, number>;
  unknownLists: Map<string, number>;
};

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

type BuildCtx = {
  cls: FillClass;
  values: string[];
  parent: Map<number, string | number>;
  idValues: Map<string, string> | undefined;
  flatRows: Map<string, FillRow> | undefined;
  stats: FillStats;
};

const idMap = (ctx: BuildCtx): Map<string, string> => {
  let m = ctx.idValues;
  if (!m) {
    m = new Map();
    for (let i = 0; i < ctx.cls.ids.length; i++) m.set(ctx.cls.ids[i].key, ctx.values[i]);
    ctx.idValues = m;
  }
  return m;
};

const flatDest = (
  ctx: BuildCtx,
  table: FillTable,
  planIds: { col: number; key: string }[],
  meta: MetaCols,
): Map<number, string | number> => {
  if (table.name === ctx.cls.table.name) return ctx.parent;
  let e = ctx.flatRows?.get(table.name);
  if (!e) {
    const values = new Map<number, string | number>();
    for (const id of planIds) values.set(id.col, idMap(ctx).get(id.key)!);
    e = { table, values, meta };
    (ctx.flatRows ??= new Map()).set(table.name, e);
    ctx.stats.childRows++;
  }
  return e.values;
};

const childRow = (
  ctx: BuildCtx,
  listName: string,
  plan: ChildList,
  n: number,
  items: [string | null, string][],
): Map<number, string | number> => {
  const row = new Map<number, string | number>();
  const ids = idMap(ctx);
  for (const id of plan.ids) {
    const v = ids.get(id.key);
    if (v !== undefined) row.set(id.col, v);
  }
  if (plan.listIdCol !== null) row.set(plan.listIdCol, n + 1);
  for (const [pn, pv] of items) {
    const col = pn ? plan.values.get(lower(pn)) : (plan.flatValueCol ?? undefined);
    if (col !== undefined) row.set(col, pv);
    else if (pn) bump(ctx.stats.unknownParams, `${ctx.cls.dbClass}.${listName}.${pn}`);
  }
  return row;
};

export type FillSinkOptions = {
  exportMs: number;
  emit: (rows: FillRow[]) => void | Promise<void>;
  onObject?: () => void;
};

export function createFillSink(
  schema: FillSchema,
  opts: FillSinkOptions,
): { sink: XmlTagSink; stats: FillStats; finish: () => void | Promise<void> } {
  const stats: FillStats = {
    objects: 0,
    parentRows: 0,
    childRows: 0,
    skippedClass: new Map(),
    unknownParams: new Map(),
    unknownLists: new Map(),
  };
  let current: Resolved | null = null;
  let pendingSelf: Resolved[] = [];
  const out: FillRow[] = [];
  const ctx: BuildCtx = {
    cls: null as unknown as FillClass,
    values: [],
    parent: new Map(),
    idValues: undefined,
    flatRows: undefined,
    stats,
  };

  const build = (r: Resolved, parsed: ObjectBody): void | Promise<void> => {
    const { cls, values } = r;
    const ids = cls.ids;
    const parent = new Map<number, string | number>();
    for (let i = 0; i < ids.length; i++) parent.set(ids[i].col, values[i]);
    // mapping_type=2 rows: one row per destination table, all its lists merged into it.
    ctx.cls = cls;
    ctx.values = values;
    ctx.parent = parent;
    ctx.idValues = undefined;
    ctx.flatRows = undefined;

    for (let pi = 0; pi < parsed.params.length; pi += 2) {
      const name = parsed.params[pi];
      const value = parsed.params[pi + 1];
      let col = cls.paramLookup.get(name);
      if (col === undefined) {
        col = cls.cols.get(lower(name)) ?? false;
        cls.paramLookup.set(name, col);
      }
      if (col !== false) {
        parent.set(col, value);
        continue;
      }
      let flat = cls.flatParamLookup.get(name);
      if (flat === undefined) {
        flat = schema.flatParams.get(lower(name)) ?? false;
        cls.flatParamLookup.set(name, flat);
      }
      const hit = flat
        ? flat.find((p) => p.re.test(r.dn) && p.ids.every((id) => idMap(ctx).has(id.key)))
        : undefined;
      if (hit) flatDest(ctx, hit.table, hit.ids, hit.meta).set(hit.col, value);
      else bump(stats.unknownParams, `${cls.dbClass}.${name}`);
    }

    // NetAct materialises empty rows for every same-distName block table of the parent class.
    for (const b of cls.blocks) {
      if (b.table.name !== cls.table.name && !(ctx.flatRows as Map<string, FillRow> | undefined)?.has(b.table.name) && b.ids.every((id) => idMap(ctx).has(id.key))) {
        flatDest(ctx, b.table, b.ids, b.meta);
      }
    }

    out.length = 0;
    out.push({ table: cls.table, values: parent, meta: cls.meta });
    stats.parentRows++;

    for (const [name, data] of parsed.lists) {
      const child = cls.lists.get(lower(name));
      if (child) {
        const items = data.items.length ? data.items : data.scalars.map((v): [string | null, string][] => [[null, v]]);
        for (let n = 0; n < items.length; n++) {
          out.push({ table: child.table, values: childRow(ctx, name, child, n, items[n]), meta: child.meta });
          stats.childRows++;
        }
        continue;
      }

      const flat = schema.flat.get(lower(name));
      const plan = flat?.find((p) => p.re.test(r.dn) && p.ids.every((id) => idMap(ctx).has(id.key)));
      if (plan) {
        const dest = flatDest(ctx, plan.table, plan.ids, plan.meta);
        if (data.items.length) {
          for (const item of data.items) {
            for (const [pn, pv] of item) {
              if (!pn) continue;
              const col = plan.values.get(lower(pn));
              if (col !== undefined) dest.set(col, pv);
              else bump(stats.unknownParams, `${cls.dbClass}.${name}.${pn}`);
            }
          }
        } else {
          for (const v of data.scalars) {
            if (plan.flatValueCol !== null) dest.set(plan.flatValueCol, v);
            else bump(stats.unknownParams, `${cls.dbClass}.${name}`);
          }
        }
        continue;
      }

      // Export/template name drift (e.g. ntpServerIpAddrList vs ...AddrOrFqdnList): a class with
      // exactly one scalar child list can safely adopt an unmapped scalar list.
      if (data.items.length === 0 && cls.scalarLists.length === 1) {
        const fallback = cls.scalarLists[0];
        for (let n = 0; n < data.scalars.length; n++) {
          out.push({ table: fallback.table, values: childRow(ctx, name, fallback, n, [[null, data.scalars[n]]]), meta: fallback.meta });
          stats.childRows++;
        }
        continue;
      }

      bump(stats.unknownLists, `${cls.dbClass}.${name}`);
    }

    if (ctx.flatRows) for (const row of (ctx.flatRows as Map<string, FillRow>).values()) out.push(row);

    const p = opts.emit(out);
    if (p) return p.then(() => opts.onObject?.());
    opts.onObject?.();
  };

  const emptyBody: ObjectBody = { params: [], lists: new Map() };

  const flushSelf = (): void | Promise<void> => {
    if (pendingSelf.length === 0) return;
    const list = pendingSelf;
    pendingSelf = [];
    let p: void | Promise<void> = undefined;
    for (const r of list) {
      if (p) p = p.then(() => build(r, emptyBody));
      else p = build(r, emptyBody);
    }
    return p;
  };

  return {
    sink: {
      onTag(tag, selfClose) {
        const text = tag.toString("utf8");
        const cls = attrValue(text, "class");
        const dn = attrValue(text, "distName");
        if (!cls || !dn) return false;
        const r = resolveClass(schema, cls, dn);
        stats.objects++;
        if (!r) {
          bump(stats.skippedClass, cls);
          return false;
        }
        if (selfClose) pendingSelf.push(r);
        else current = r;
        return !selfClose;
      },
      onBody(body) {
        const r = current;
        current = null;
        if (pendingSelf.length) {
          const p = flushSelf();
          if (p) return r ? p.then(() => build(r, parseManagedObjectBody(body))) : p;
        }
        if (r) return build(r, parseManagedObjectBody(body));
      },
    },
    stats,
    finish: flushSelf,
  };
}

export type RowWriter = {
  write: (rows: FillRow[]) => void | Promise<void>;
  finish: () => void | Promise<void>;
};

/**
 * Encodes sparse rows into the line protocol.  `writeText` owns the transport (Java stdin or a
 * worker's stdout) and returns a promise only when the transport is backpressured.
 */
export function createRowWriter(
  exportMs: number,
  writeText: (text: string) => void | Promise<void>,
  tableId: (tableName: string) => number = (() => {
    let n = 0;
    return () => ++n;
  })(),
): RowWriter {
  const enc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s === "") return "!";
    if (s === "!") return "\\!";
    if (s.indexOf("\\") === -1 && s.indexOf("\t") === -1 && s.indexOf("\n") === -1 && s.indexOf("\r") === -1) return s;
    return s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  };
  const statusEnc = enc("ACTUAL");
  const timeEnc = enc(exportMs);

  let chunk: string[] = [];
  let pending = 0;
  const flush = (force = false): void | Promise<void> => {
    if (!force && pending < 4 * 1024 * 1024) return;
    const text = chunk.join("");
    chunk = [];
    pending = 0;
    return writeText(text);
  };

  type EmitTable = { id: number; nmsIndex: number };
  const tableMeta = new Map<string, EmitTable>();

  const write = (rows: FillRow[]): void | Promise<void> => {
    for (const r of rows) {
      let meta = tableMeta.get(r.table.name);
      if (!meta) {
        const nmsIndex = r.table.index.get("nms_id") ?? -1;
        meta = { id: tableId(r.table.name), nmsIndex };
        tableMeta.set(r.table.name, meta);
        chunk.push(`H\t${meta.id}\t${r.table.name}\t${r.table.cols.map((c) => c.name).join("\t")}\n`);
        pending += 64 + r.table.cols.length * 12;
      }
      let pairCount = 0;
      let rowLine = `R\t${meta.id}`;
      if (meta.nmsIndex >= 0 && !r.values.has(meta.nmsIndex)) {
        rowLine += `\t${meta.nmsIndex}:1`;
        pairCount++;
      }
      for (const [idx, v] of r.values) {
        if (v === "" || v === null || v === undefined) continue;
        rowLine += `\t${idx}:${enc(v)}`;
        pairCount++;
      }
      if (r.meta.status !== null) {
        rowLine += `\t${r.meta.status}:${statusEnc}`;
        pairCount++;
      }
      if (r.meta.modified !== null) {
        rowLine += `\t${r.meta.modified}:${timeEnc}`;
        pairCount++;
      }
      if (r.meta.imported !== null) {
        rowLine += `\t${r.meta.imported}:${timeEnc}`;
        pairCount++;
      }
      chunk.push(`${rowLine}\n`);
      pending += 12 + pairCount * 4;
    }
    return flush();
  };

  return { write, finish: () => flush(true) };
}

export type FillOptions = {
  templatePath: string;
  xml: AsyncIterable<Buffer | Uint8Array>;
  /** Direct XML file path. When set, large exports are split across seekable worker processes. */
  xmlPath?: string;
  workers?: number;
  outPath: string;
  onProgress?: (p: { objects: number; rows: number; phase: string; bytes?: number }) => void;
};

export type FillResult = FillStats & {
  errors: number;
  errorSamples: string[];
  errorTables: [string, number][];
  exportTime: string | null;
};

function findJavaBinary(home: string | undefined): string | null {
  if (!home) return null;
  const bin = path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
  return fs.existsSync(bin) ? bin : null;
}

function childDirs(parent: string): string[] {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(parent, e.name));
  } catch {
    return [];
  }
}

/** MDB_FILL_JAVA, then JAVA_HOME, tools/jre, common installer locations, then PATH. */
export function resolveJava(): string {
  const configured = process.env.MDB_FILL_JAVA?.trim();
  if (configured) return configured;

  for (const home of [process.env.JAVA_HOME, path.join(process.cwd(), "tools", "jre")]) {
    const bin = findJavaBinary(home);
    if (bin) return bin;
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : undefined,
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".jdks") : undefined,
    ];
    const vendors = ["Eclipse Adoptium", "Java", "Microsoft", "Amazon Corretto", "Zulu", "BellSoft", "Semeru", "AdoptOpenJDK"];
    for (const root of roots) {
      if (!root) continue;
      const direct = findJavaBinary(root);
      if (direct) return direct;
      for (const vendor of vendors) {
        const vendorDir = path.join(/* turbopackIgnore: true */ root, vendor);
        const found =
          findJavaBinary(vendorDir) ??
          childDirs(vendorDir)
            .map((dir) => findJavaBinary(dir))
            .find((bin): bin is string => !!bin);
        if (found) return found;
      }
    }
  } else {
    if (process.platform === "darwin") {
      const found = childDirs("/Library/Java/JavaVirtualMachines")
        .map((dir) => findJavaBinary(path.join(dir, "Contents", "Home")))
        .find((bin): bin is string => !!bin);
      if (found) return found;
    }
    for (const bin of ["/usr/bin/java", "/usr/local/bin/java", "/opt/java/openjdk/bin/java"]) {
      if (fs.existsSync(bin)) return bin;
    }
  }
  return "java";
}

function readFileHead(file: string, bytes: number): string {
  const buf = Buffer.allocUnsafe(bytes);
  const fd = fs.openSync(file, "r");
  try {
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const OBJECT_TAG = "<managedObject";
function findObjectTag(buf: Buffer, from = 0): number {
  for (let i = buf.indexOf(OBJECT_TAG, from); i !== -1; i = buf.indexOf(OBJECT_TAG, i + 1)) {
    const next = buf[i + OBJECT_TAG.length];
    if (next === 32 || next === 9 || next === 10 || next === 13 || next === 62) return i;
  }
  return -1;
}

/** Byte offsets of complete `<managedObject>` boundaries, first 0 and last file size. */
async function xmlSplitPoints(file: string, size: number, parts: number): Promise<number[]> {
  const points = [0];
  const fh = await fs.promises.open(file, "r");
  try {
    for (let p = 1; p < parts; p++) {
      const target = Math.floor((size * p) / parts);
      const previous = points[points.length - 1];
      if (target <= previous + 1) continue;
      const len = Math.min(64 << 20, size - target);
      if (len <= 0) continue;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, target);
      const idx = findObjectTag(buf.subarray(0, bytesRead));
      if (idx < 0) continue;
      const pos = target + idx;
      if (pos > previous + 1) points.push(pos);
    }
  } finally {
    await fh.close();
  }
  points.push(size);
  return points;
}

type ParallelConfig = { java: string; cp: string; heap: string; workers: number; exportMs: number; exportTime: string | null };

async function fillDatabaseParallel(opts: FillOptions, schema: FillSchema, cfg: ParallelConfig): Promise<FillResult> {
  const { spawn } = await import("node:child_process");
  const { StringDecoder } = await import("node:string_decoder");
  const xmlPath = opts.xmlPath!;
  const size = fs.statSync(xmlPath).size;
  const points = await xmlSplitPoints(xmlPath, size, cfg.workers);

  const workers: ReturnType<typeof spawn>[] = [];
  let javaExited = false;
  const child = spawn(cfg.java, [cfg.heap, "-XX:+UseSerialGC", "-Duser.timezone=UTC", "-cp", cfg.cp, "MdbFill", opts.outPath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let errors = 0;
  const errorSamples: string[] = [];
  const errorTables = new Map<string, number>();
  child.stderr!.on("data", (d: Buffer) => {
    const s = d.toString();
    if (process.env.MDB_FILL_VERBOSE === "1") process.stderr.write(s);
    stderr += s;
    if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024);
    if (s.includes("ERR ")) {
      errors += (s.match(/(^|\n)ERR /g) ?? []).length;
      for (const m of s.matchAll(/(?:^|\n)ERR (\S+)/g)) errorTables.set(m[1], (errorTables.get(m[1]) ?? 0) + 1);
      if (errorSamples.length < 20) for (const line of s.split(/\r?\n/)) if (line.startsWith("ERR ")) errorSamples.push(line);
    }
  });
  child.on("exit", () => {
    javaExited = true;
    for (const w of workers) w.kill();
  });
  child.stdin!.on("error", () => {});
  child.stdin!.setMaxListeners(0);
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  exit.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const workerPath = process.env.MDB_FILL_WORKER ?? path.join(process.cwd(), "src", "lib", "fillWorker.ts");
  const execArgv = process.execArgv.includes("tsx")
    ? process.execArgv
    : ["--import", "tsx", ...process.execArgv];
  if (!execArgv.some((a) => a.startsWith("--max-semi-space-size"))) execArgv.push("--max-semi-space-size=64");

  const workerStats: FillStats[] = [];
  const streams: NodeJS.ReadableStream[] = [];
  let javaPaused = false;
  const pauseAll = () => {
    if (javaPaused) return;
    javaPaused = true;
    for (const s of streams) s.pause();
  };
  const resumeAll = () => {
    if (!javaPaused) return;
    javaPaused = false;
    for (const s of streams) s.resume();
  };
  const writeJava = (text: string) => {
    if (!text) return;
    if (!child.stdin!.write(text)) {
      pauseAll();
      child.stdin!.once("drain", resumeAll);
      child.stdin!.once("close", resumeAll);
    }
  };

  let progressObjects = 0;
  let progressRows = 0;
  let progressBytes = 0;
  let lastProgress = 0;
  const progress = points.slice(1).map(() => ({ objects: 0, rows: 0, bytes: 0 }));
  const done = points.slice(1).map((end, i) => {
    const start = points[i];
    const w = spawn(process.execPath, [...execArgv, workerPath, opts.templatePath, xmlPath, String(start), String(end), String(cfg.exportMs)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    workers.push(w);
    if (javaExited) w.kill();
    w.stdin?.on("error", () => {});
    let carry = "";
    const decoder = new StringDecoder("utf8");
    const out = w.stdout!;
    streams.push(out);
    out.on("data", (d: Buffer) => {
      carry += decoder.write(d);
      const nl = carry.lastIndexOf("\n");
      if (nl >= 0) {
        writeJava(carry.slice(0, nl + 1));
        carry = carry.slice(nl + 1);
      }
    });
    out.on("end", () => {
      carry += decoder.end();
      if (carry) writeJava(carry);
    });
    w.on("message", (m: { type?: string; objects?: number; rows?: number; bytes?: number; stats?: FillStats }) => {
      if (m.type === "stats" && m.stats) workerStats[i] = m.stats;
      if (m.type !== "progress") return;
      progress[i] = { objects: m.objects ?? 0, rows: m.rows ?? 0, bytes: m.bytes ?? 0 };

      const now = Date.now();
      if (now - lastProgress < 1000) return;
      lastProgress = now;
      progressObjects = 0;
      progressRows = 0;
      progressBytes = 0;
      for (const p of progress) {
        progressObjects += p.objects;
        progressRows += p.rows;
        progressBytes += p.bytes;
      }
      opts.onProgress?.({ objects: progressObjects, rows: progressRows, bytes: progressBytes, phase: "fill" });
    });
    let workerErr = "";
    w.stderr!.on("data", (d: Buffer) => {
      workerErr += d.toString();
      if (workerErr.length > 32 * 1024) workerErr = workerErr.slice(-32 * 1024);
    });
    return new Promise<number>((resolve, reject) => {
      w.on("error", reject);
      w.on("close", (code) => {
        if (code !== 0) reject(new Error(`Dump worker failed (exit ${code}). ${workerErr.trim().split(/\r?\n/).slice(-3).join(" ")}`));
        else resolve(code ?? 0);
      });
    });
  });

  try {
    await Promise.all(done);
    if (workerStats.length !== points.length - 1) throw new Error("Dump workers did not report their statistics.");
    child.stdin!.end("E\n");
    const code = await exit;
    if (code !== 0) {
      throw new Error(`Database writer failed (exit ${code}). ${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}`);
    }
    const merged: FillStats = {
      objects: 0,
      parentRows: 0,
      childRows: 0,
      skippedClass: new Map(),
      unknownParams: new Map(),
      unknownLists: new Map(),
    };
    for (const s of workerStats) {
      merged.objects += s.objects;
      merged.parentRows += s.parentRows;
      merged.childRows += s.childRows;
      for (const [k, v] of s.skippedClass) merged.skippedClass.set(k, (merged.skippedClass.get(k) ?? 0) + v);
      for (const [k, v] of s.unknownParams) merged.unknownParams.set(k, (merged.unknownParams.get(k) ?? 0) + v);
      for (const [k, v] of s.unknownLists) merged.unknownLists.set(k, (merged.unknownLists.get(k) ?? 0) + v);
    }
    return {
      ...merged,
      errors,
      errorSamples,
      errorTables: [...errorTables].sort((a, b) => b[1] - a[1]).slice(0, 20),
      exportTime: cfg.exportTime,
    };
  } catch (e) {
    for (const w of workers) w.kill();
    child.kill();
    await exit.catch(() => {});
    throw e;
  }
}

export function defaultFillWorkers(): number {
  const cpus = Math.max(1, os.availableParallelism());
  return cpus < 2 ? 1 : Math.min(4, Math.max(2, cpus - 1));
}

/** Converts the XML stream into rows and inserts them into `outPath` (a copy of the template). */
export async function fillDatabase(opts: FillOptions, schema: FillSchema): Promise<FillResult> {
  const { spawn } = await import("node:child_process");
  const java = resolveJava();
  const classes = process.env.MDB_FILL_CLASSES ?? "tools/mdb-fill/classes";
  const jar = process.env.MDB_FILL_JAR ?? "tools/mdb-fill/jackcess-5.0.4.jar";
  const cp = `${classes}${process.platform === "win32" ? ";" : ":"}${jar}`;
  const heap = process.env.MDB_FILL_HEAP ?? "-Xmx448m";

  const configured = Number(process.env.MDB_FILL_WORKERS);
  const workers =
    opts.workers ?? (Number.isFinite(configured) ? configured : defaultFillWorkers());
  const workerFile = process.env.MDB_FILL_WORKER ?? path.join(process.cwd(), "src", "lib", "fillWorker.ts");
  if (opts.xmlPath && workers > 1 && fs.existsSync(/* turbopackIgnore: true */ workerFile)) {
    const size = fs.statSync(opts.xmlPath).size;
    if (size >= 64 * 1024 * 1024) {
      const headText = readFileHead(opts.xmlPath, 16384);
      const exportTime = exportTimeFromXml(headText);
      const exportMs = (exportTime ? wallClockMs(exportTime) : null) ?? Date.now();
      return fillDatabaseParallel(opts, schema, { java, cp, heap, workers, exportMs, exportTime });
    }
  }

  const toBuf = (c: Buffer | Uint8Array): Buffer =>
    Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);

  // Peek the header first: last_modified / last_actual_import are the export timestamp.
  const it = opts.xml[Symbol.asyncIterator]();
  const head: Buffer[] = [];
  let headLen = 0;
  let headText = "";
  while (headLen < 16384) {
    const n = await it.next();
    if (n.done) break;
    if (!n.value || n.value.length === 0) continue;
    const b = toBuf(n.value);
    head.push(b);
    headLen += b.length;
    headText += b.toString("utf8");
    if (headText.includes("</header>")) break;
  }
  const exportTime = exportTimeFromXml(headText);
  const exportMs = (exportTime ? wallClockMs(exportTime) : null) ?? Date.now();

  const child = spawn(java, [heap, "-XX:+UseSerialGC", "-Duser.timezone=UTC", "-cp", cp, "MdbFill", opts.outPath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let errors = 0;
  const errorSamples: string[] = [];
  const errorTables = new Map<string, number>();
  child.stderr!.on("data", (d: Buffer) => {
    const s = d.toString();
    if (process.env.MDB_FILL_VERBOSE === "1") process.stderr.write(s);
    stderr += s;
    if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024);
    if (s.includes("ERR ")) {
      errors += (s.match(/(^|\n)ERR /g) ?? []).length;
      for (const m of s.matchAll(/(?:^|\n)ERR (\S+)/g)) errorTables.set(m[1], (errorTables.get(m[1]) ?? 0) + 1);
      if (errorSamples.length < 20) for (const line of s.split(/\r?\n/)) if (line.startsWith("ERR ")) errorSamples.push(line);
    }
  });
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  // The error event may fire while the XML is still parsed; keep `exit` handled so a missing
  // Java binary surfaces through the caller instead of an unhandled rejection.
  exit.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "ENOENT"
          ? new Error(
              `Java was not found (${java}). Install Java 17+, set JAVA_HOME, or set MDB_FILL_JAVA to the java executable.`,
            )
          : err,
      ),
    );
  });

  let objects = 0;
  const writer = createRowWriter(exportMs, (text) => {
    if (!child.stdin!.write(text)) {
      // A dead writer never emits "drain"; also resolve on close/error so the job fails instead of hanging.
      return new Promise<void>((resolve) => {
        const stdin = child.stdin!;
        const done = () => {
          stdin.off("drain", done);
          stdin.off("close", done);
          stdin.off("error", done);
          resolve();
        };
        stdin.once("drain", done);
        stdin.once("close", done);
        stdin.once("error", done);
      });
    }
  });

  const { sink, stats, finish } = createFillSink(schema, {
    exportMs,
    onObject: () => {
      objects++;
      if ((objects & 0x1fff) === 0) {
        opts.onProgress?.({ objects: stats.objects, rows: stats.parentRows + stats.childRows, phase: "fill" });
      }
    },
    emit: writer.write,
  });

  try {
    const src = (async function* () {
      for (const b of head) yield b;
      for (;;) {
        const n = await it.next();
        if (n.done) return;
        if (n.value && n.value.length) yield toBuf(n.value);
      }
    })();
    await parseXmlStream(src, sink);
    await finish();
    await writer.finish();
    child.stdin!.end("E\n");
    const code = await exit;
    if (code !== 0) {
      throw new Error(`Database writer failed (exit ${code}). ${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}`);
    }
    return {
      ...stats,
      errors,
      errorSamples,
      errorTables: [...errorTables].sort((a, b) => b[1] - a[1]).slice(0, 20),
      exportTime,
    };
  } catch (e) {
    child.kill();
    await exit.catch(() => {});
    throw e;
  }
}

export function exportTimeFromXml(head: string): string | null {
  return head.match(/<log[^>]*dateTime="([^"]+)"/)?.[1] ?? null;
}

/**
 * The export timestamp is wall-clock time in the export's zone, and NetAct stores that wall clock
 * verbatim (no timezone conversion).  Interpret it as UTC and run the writer with
 * -Duser.timezone=UTC so the Access datetime serial matches the source dump on any server.
 */
export function wallClockMs(iso: string): number | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
}
