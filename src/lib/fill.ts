import fs from "node:fs";
import path from "node:path";
import MDBReader from "mdb-reader";
import { openFileBuffer } from "./fileBuffer";
import { attrValue, parseXmlStream, type XmlTagSink } from "./xmlscan";

/**
 * Fill an empty NetAct dump (.mdb) from a RAML XML export.
 *
 * The empty dump carries the import metadata: IMPORT_CLASS_FILTER maps a RAML class to the class
 * name used by the database and gives its distName format + id parameters; IMPORT_LIST_MAPPING
 * describes nested lists (a child table, or columns flattened onto the parent).  Tables are named
 * `A_<class>`; child rows repeat the parent ids and append `listId`.
 *
 * Rows are streamed to the Java Jackcess helper (tools/mdb-fill), the only MDB writer that runs on
 * Linux.  Values are Base64 so tabs/newlines inside names cannot break the line protocol:
 *
 *   H <table> <col1> <col2> ...   declare a table's column order (once)
 *   R <table> <v1> <v2> ...       one row
 *   E                             end of input
 */

export type FillCol = { name: string; type: string; size: number };
export type FillTable = { name: string; cols: FillCol[]; byLower: Map<string, FillCol> };

type ChildList = {
  kind: "child";
  table: FillTable;
  ids: { col: string; key: string }[];
  listIdCol: string | null;
  values: Map<string, string>;
  flatValueCol: string | null;
  meta: MetaCols;
};

/** A mapping_type=2 list: its items are flattened into columns of (another) table. */
export type FlatList = {
  table: FillTable;
  /** the destination class rule - any object whose distName matches is a candidate */
  re: RegExp;
  ids: { col: string; key: string }[];
  /** lower-case item parameter (and every suffix) -> destination column */
  values: Map<string, string>;
  /** for lists of plain scalar values, the single destination column */
  flatValueCol: string | null;
  meta: MetaCols;
};

/**
 * A parent parameter that the database stores in a same-distName block table (e.g. LNCEL's
 * a3Offset lives in A_LTE_LNCEL_HC, NRCELL's numOfSubSectors in A_NRBTS_NRCELL_SCH).
 */
export type FlatParam = {
  table: FillTable;
  re: RegExp;
  ids: { col: string; key: string }[];
  col: string;
  meta: MetaCols;
};

type MetaCols = { status: string | null; modified: string | null; imported: string | null };

/** A same-distName block table: NetAct writes one row per parent object, even when empty. */
export type BlockTable = { table: FillTable; ids: { col: string; key: string }[]; meta: MetaCols };

export type FillClass = {
  dbClass: string;
  table: FillTable;
  ids: { col: string; key: string }[];
  /** captures the distName id values (handles several ids inside one segment, e.g. ADCE-%5d%d) */
  idRe: RegExp;
  /** capture-group offset when the format's first group is the PLMN and not an id column */
  idOffset: number;
  /** lower-case XML parameter -> table column */
  cols: Map<string, string>;
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
  stats: { classes: number; lists: number };
};

const META = new Set(["template_name", "template_set", "status", "last_modified", "last_actual_import"]);
const lower = (s: string) => s.toLowerCase();

const asRows = (reader: MDBReader, name: string): Record<string, unknown>[] =>
  reader.getTable(name).getData() as unknown as Record<string, unknown>[];

const asTable = (reader: MDBReader, name: string): FillTable => {
  const t = reader.getTable(name);
  const cols: FillCol[] = (t.getColumns() as unknown as FillCol[]).map((c) => ({ name: c.name, type: c.type, size: c.size }));
  return { name, cols, byLower: new Map(cols.map((c) => [lower(c.name), c])) };
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
    status: table.byLower.get("status")?.name ?? null,
    modified: table.byLower.get("last_modified")?.name ?? null,
    imported: table.byLower.get("last_actual_import")?.name ?? null,
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
        const col = t.byLower.get(lower(k));
        return col ? [{ col: col.name, key: lower(k) }] : [];
      });
      if (ids.length !== idNames.length) {
        classes.set(dbClass, null);
        continue;
      }

      const cols = new Map<string, string>();
      for (const c of t.cols) if (!META.has(lower(c.name))) cols.set(lower(c.name), c.name);

      const lists = new Map<string, ChildList>();
      const scalarLists: ChildList[] = [];
      for (const r of listsByClass.get(dbClass) ?? []) {
        if (Number(r.mapping_type) !== 1 || !r.child_class) continue;
        const name = String(r.list);
        const child = table(`A_${r.child_class}`);
        if (!child) continue;
        const keyCols = new Set(ids.map((i) => lower(i.col)));
        const listId = child.byLower.get("listid")?.name ?? null;
        if (listId) keyCols.add("listid");
        const values = new Map<string, string>();
        for (const c of child.cols) {
          const lc = lower(c.name);
          if (keyCols.has(lc) || META.has(lc)) continue;
          values.set(lc, c.name);
        }
        const flatValueCol = values.size === 1 ? [...values.values()][0] : (values.get(lower(name)) ?? null);
        const plan: ChildList = {
          kind: "child",
          table: child,
          ids: ids.map((i) => ({ col: child.byLower.get(lower(i.col))?.name ?? i.col, key: i.key })),
          listIdCol: listId,
          values,
          flatValueCol,
          meta: metaOf(child),
        };
        lists.set(lower(name), plan);
        if (flatValueCol) scalarLists.push(plan);
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
          const col = bt.byLower.get(lower(k));
          return col ? [{ col: col.name, key: lower(k) }] : [];
        });
        if (blockIds.length !== brule.ids.length) continue;
        blocks.push({ table: bt, ids: blockIds, meta: metaOf(bt) });
      }

      classes.set(dbClass, { dbClass, table: t, ids, idRe: capture.re, idOffset, cols, lists, scalarLists, blocks, meta: metaOf(t) });
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
        const col = dest.byLower.get(lower(k));
        return col ? [{ col: col.name, key: lower(k) }] : [];
      });
      if (ids.length !== rule.ids.length) continue;
      const values = new Map<string, string>();
      for (const target of splitList(r.parameter_prefix_list)) {
        const col = dest.byLower.get(lower(target));
        if (!col) continue;
        for (const key of suffixKeys(target)) if (!values.has(key)) values.set(key, col.name);
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
        const col = dest.byLower.get(lower(k));
        return col ? [{ col: col.name, key: lower(k) }] : [];
      });
      if (ids.length !== rule.ids.length) continue;
      const meta = metaOf(dest);
      for (const r of rows) {
        const col = dest.byLower.get(lower(String(r.parameter)));
        if (!col) continue;
        const xmlName = lower(String(r.external_name ?? r.parameter));
        const plan: FlatParam = { table: dest, re: rule.re, ids, col: col.name, meta };
        const arr = flatParams.get(xmlName);
        if (arr) arr.push(plan);
        else flatParams.set(xmlName, [plan]);
      }
    }

    return {
      tableNames,
      rules,
      classes,
      flat,
      flatParams,
      cache: new Map<string, FillClass | null>(),
      stats: { classes: classes.size, lists: listCount },
    };
  } finally {
    buf.close();
  }
}

/** distName shape without instance ids - one class resolution per shape, not per object. */
function dnShape(dn: string): string {
  return dn
    .split("/")
    .map((s) => {
      const i = s.indexOf("-");
      return i === -1 ? s : s.slice(0, i);
    })
    .join("/");
}

export type Resolved = { cls: FillClass; dn: string; ids: { col: string; value: string }[] };

function idsFor(cls: FillClass, dn: string): Resolved | null {
  const m = cls.idRe.exec(dn);
  if (m) {
    const values = m.slice(1 + cls.idOffset);
    if (values.length === cls.ids.length) {
      return { cls, dn, ids: cls.ids.map((c, i) => ({ col: c.col, value: values[i] })) };
    }
  }
  // Fallback for formats whose DN has a PLMN prefix that is not part of the format.
  const segs = dn.split("/");
  const off = segs[0]?.startsWith("PLMN-") ? 1 : 0;
  if (segs.length - off !== cls.ids.length) return null;
  return {
    cls,
    dn,
    ids: cls.ids.map((c, i) => {
      const s = segs[off + i];
      const dash = s.indexOf("-");
      return { col: c.col, value: dash === -1 ? s : s.slice(dash + 1) };
    }),
  };
}

/** Resolve a managed object (class + distName) to its table and id values. */
export function resolveClass(schema: FillSchema, xmlClass: string, dn: string): Resolved | null {
  const key = `${lower(xmlClass)}\n${dnShape(dn)}`;
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

/** Parses the <p> children inside [from,to) of a list item (stops at a nested list). */
function parseP(block: string, from: number, to: number, out: [string | null, string][]) {
  let i = from;
  while (i < to) {
    const p = block.indexOf("<p", i);
    if (p === -1 || p >= to) return;
    if (p + 2 >= to) return;
    let gt: number;
    const c = block.charCodeAt(p + 2);
    if (c === 62) gt = p + 2; // <p> - a plain scalar value
    else if (c === 32 || c === 9 || c === 10 || c === 13) gt = block.indexOf(">", p + 3);
    else {
      i = p + 2;
      continue;
    }
    if (gt === -1 || gt >= to) return;
    const l = block.indexOf("<list", i);
    if (l !== -1 && l < p) return;
    if (block[gt - 1] === "/") {
      i = gt + 1;
      continue;
    }
    const close = block.indexOf("</p>", gt + 1);
    if (close === -1 || close >= to) return;
    const name = gt === p + 2 ? null : (attrValue(block.slice(p + 3, gt), "name") ?? null);
    out.push([name, decodeText(block.slice(gt + 1, close)).trim()]);
    i = close + 4;
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

/** Parses one managed-object body: flat <p> params + top-level <list> blocks. */
export function parseManagedObjectBody(body: Buffer): { params: [string, string][]; lists: ObjectLists } {
  const s = body.toString("utf8");
  const params: [string, string][] = [];
  const lists: ObjectLists = new Map();
  let i = 0;
  while (i < s.length) {
    const p = s.indexOf("<p ", i);
    const l = s.indexOf("<list ", i);
    const next = p === -1 ? l : l === -1 ? p : Math.min(p, l);
    if (next === -1) break;

    if (next === p) {
      const gt = s.indexOf(">", p + 3);
      if (gt === -1) break;
      if (s[gt - 1] === "/") {
        i = gt + 1;
        continue;
      }
      const close = s.indexOf("</p>", gt + 1);
      if (close === -1) break;
      const name = attrValue(s.slice(p + 3, gt), "name");
      if (name) params.push([name, decodeText(s.slice(gt + 1, close)).trim()]);
      i = close + 4;
    } else {
      const gt = s.indexOf(">", l + 6);
      if (gt === -1) break;
      const name = attrValue(s.slice(l + 6, gt), "name");
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

export type FillSinkOptions = {
  exportMs: number;
  emit: (rows: { table: FillTable; values: Map<string, string | number> }[]) => Promise<void>;
  onObject?: () => void;
};

export function createFillSink(
  schema: FillSchema,
  opts: FillSinkOptions,
): { sink: XmlTagSink; stats: FillStats; finish: () => Promise<void> } {
  const stats: FillStats = {
    objects: 0,
    parentRows: 0,
    childRows: 0,
    skippedClass: new Map(),
    unknownParams: new Map(),
    unknownLists: new Map(),
  };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let current: Resolved | null = null;
  let pendingSelf: Resolved[] = [];

  const setMeta = (row: Map<string, string | number>, meta: MetaCols) => {
    if (meta.status) row.set(lower(meta.status), "ACTUAL");
    if (meta.modified) row.set(lower(meta.modified), opts.exportMs);
    if (meta.imported) row.set(lower(meta.imported), opts.exportMs);
  };

  const build = async (r: Resolved, parsed: { params: [string, string][]; lists: ObjectLists }) => {
    const { cls, ids } = r;
    const idValues = new Map<string, string>();
    const parent = new Map<string, string | number>();
    for (const id of ids) {
      idValues.set(lower(id.col), id.value);
      parent.set(lower(id.col), id.value);
    }
    // mapping_type=2 rows: one row per destination table, all its lists merged into it.
    const flatRows = new Map<string, { table: FillTable; values: Map<string, string | number> }>();
    const flatDest = (table: FillTable, planIds: { col: string; key: string }[], meta: MetaCols) => {
      if (table.name === cls.table.name) return parent;
      let e = flatRows.get(table.name);
      if (!e) {
        const values = new Map<string, string | number>();
        for (const id of planIds) values.set(lower(id.col), idValues.get(id.key)!);
        setMeta(values, meta);
        e = { table, values };
        flatRows.set(table.name, e);
        stats.childRows++;
      }
      return e.values;
    };

    for (const [name, value] of parsed.params) {
      const col = cls.cols.get(lower(name));
      if (col) {
        parent.set(lower(col), value);
        continue;
      }
      const hit = schema.flatParams
        .get(lower(name))
        ?.find((p) => p.re.test(r.dn) && p.ids.every((id) => idValues.has(id.key)));
      if (hit) flatDest(hit.table, hit.ids, hit.meta).set(lower(hit.col), value);
      else bump(stats.unknownParams, `${cls.dbClass}.${name}`);
    }

    // NetAct materialises empty rows for every same-distName block table of the parent class.
    for (const b of cls.blocks) {
      if (b.table.name !== cls.table.name && !flatRows.has(b.table.name) && b.ids.every((id) => idValues.has(id.key))) {
        flatDest(b.table, b.ids, b.meta);
      }
    }

    const out: { table: FillTable; values: Map<string, string | number> }[] = [{ table: cls.table, values: parent }];
    stats.parentRows++;

    const childRow = (
      listName: string,
      plan: ChildList,
      n: number,
      items: [string | null, string][],
    ): Map<string, string | number> => {
      const row = new Map<string, string | number>();
      for (const id of plan.ids) {
        const v = idValues.get(id.key);
        if (v !== undefined) row.set(lower(id.col), v);
      }
      if (plan.listIdCol) row.set(lower(plan.listIdCol), n + 1);
      for (const [pn, pv] of items) {
        const col = pn ? plan.values.get(lower(pn)) : (plan.flatValueCol ?? undefined);
        if (col) row.set(lower(col), pv);
        else if (pn) bump(stats.unknownParams, `${cls.dbClass}.${listName}.${pn}`);
      }
      setMeta(row, plan.meta);
      return row;
    };

    for (const [name, data] of parsed.lists) {
      const child = cls.lists.get(lower(name));
      if (child) {
        const items = data.items.length ? data.items : data.scalars.map((v): [string | null, string][] => [[null, v]]);
        for (let n = 0; n < items.length; n++) {
          out.push({ table: child.table, values: childRow(name, child, n, items[n]) });
          stats.childRows++;
        }
        continue;
      }

      const flat = schema.flat.get(lower(name));
      const plan = flat?.find((p) => p.re.test(r.dn) && p.ids.every((id) => idValues.has(id.key)));
      if (plan) {
        const dest = flatDest(plan.table, plan.ids, plan.meta);
        if (data.items.length) {
          for (const item of data.items) {
            for (const [pn, pv] of item) {
              if (!pn) continue;
              const col = plan.values.get(lower(pn));
              if (col) dest.set(lower(col), pv);
              else bump(stats.unknownParams, `${cls.dbClass}.${name}.${pn}`);
            }
          }
        } else {
          for (const v of data.scalars) {
            if (plan.flatValueCol) dest.set(lower(plan.flatValueCol), v);
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
          out.push({ table: fallback.table, values: childRow(name, fallback, n, [[null, data.scalars[n]]]) });
          stats.childRows++;
        }
        continue;
      }

      bump(stats.unknownLists, `${cls.dbClass}.${name}`);
    }

    setMeta(parent, cls.meta);
    for (const row of flatRows.values()) out.push(row);

    await opts.emit(out);
    opts.onObject?.();
  };

  const flushSelf = async () => {
    if (pendingSelf.length === 0) return;
    const list = pendingSelf;
    pendingSelf = [];
    for (const r of list) await build(r, { params: [], lists: new Map() });
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
      async onBody(body) {
        const r = current;
        current = null;
        if (pendingSelf.length) await flushSelf();
        if (!r) return;
        await build(r, parseManagedObjectBody(body));
      },
    },
    stats,
    finish: flushSelf,
  };
}

export type FillOptions = {
  templatePath: string;
  xml: AsyncIterable<Buffer | Uint8Array>;
  outPath: string;
  onProgress?: (p: { objects: number; rows: number; phase: string }) => void;
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
        const vendorDir = path.join(root, vendor);
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

/** Converts the XML stream into rows and inserts them into `outPath` (a copy of the template). */
export async function fillDatabase(opts: FillOptions, schema: FillSchema): Promise<FillResult> {
  const { spawn } = await import("node:child_process");
  const java = resolveJava();
  const classes = process.env.MDB_FILL_CLASSES ?? "tools/mdb-fill/classes";
  const jar = process.env.MDB_FILL_JAR ?? "tools/mdb-fill/jackcess-5.0.4.jar";
  const cp = `${classes}${process.platform === "win32" ? ";" : ":"}${jar}`;
  const heap = process.env.MDB_FILL_HEAP ?? "-Xmx448m";

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

  const child = spawn(java, [heap, "-Duser.timezone=UTC", "-cp", cp, "MdbFill", opts.outPath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let errors = 0;
  const errorSamples: string[] = [];
  const errorTables = new Map<string, number>();
  child.stderr!.on("data", (d: Buffer) => {
    const s = d.toString();
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
  const declared = new Set<string>();
  const encCache = new Map<string, string>();
  const enc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return "-";
    const s = String(v);
    if (s === "") return "!";
    if (s.length <= 8) {
      const hit = encCache.get(s);
      if (hit !== undefined) return hit;
      const b = Buffer.from(s, "utf8").toString("base64");
      if (encCache.size < 100_000) encCache.set(s, b);
      return b;
    }
    return Buffer.from(s, "utf8").toString("base64");
  };

  let chunk: string[] = [];
  let pending = 0;
  const write = async (force = false) => {
    if (!force && pending < 512 * 1024) return;
    const text = chunk.join("");
    chunk = [];
    pending = 0;
    if (!child.stdin!.write(text)) {
      // A dead writer never emits "drain"; also resolve on close/error so the job fails instead of hanging.
      await new Promise<void>((resolve) => {
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
  };

  const { sink, stats, finish } = createFillSink(schema, {
    exportMs,
    onObject: () => {
      objects++;
      if ((objects & 0x1fff) === 0) {
        opts.onProgress?.({ objects: stats.objects, rows: stats.parentRows + stats.childRows, phase: "fill" });
      }
    },
    emit: async (rows) => {
      for (const r of rows) {
        // nms_id is not part of the OSS distName, but several tables have it in their ID index.
        const nms = r.table.byLower.get("nms_id");
        if (nms && !r.values.has("nms_id")) r.values.set("nms_id", 1);
        if (!declared.has(r.table.name)) {
          declared.add(r.table.name);
          chunk.push(`H\t${r.table.name}\t${r.table.cols.map((c) => c.name).join("\t")}\n`);
          pending += 64;
        }
        const vals: string[] = [];
        for (const c of r.table.cols) {
          const v = r.values.get(lower(c.name));
          vals.push(enc(v));
        }
        chunk.push(`R\t${r.table.name}\t${vals.join("\t")}\n`);
        pending += 16 + vals.length * 2;
      }
      await write();
    },
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
    chunk.push("E\n");
    await write(true);
    child.stdin!.end();
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
