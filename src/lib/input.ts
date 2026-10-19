import Papa from "papaparse";
import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import type { Row } from "./types";

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellToString(o.result); // formula cell
    if (Array.isArray(o.richText)) return o.richText.map((t: { text: string }) => t.text).join("");
    if ("text" in o) return String(o.text);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

/**
 * XLSX via ExcelJS's streaming reader: the unpacked workbook is not held in memory, so a sheet
 * with hundreds of thousands of rows is read row by row. Only the first worksheet is used.
 *
 * The stream reader resolves shared strings only if `sharedStrings.xml` precedes the worksheets
 * in the zip (true for Excel / LibreOffice output). Some generators put it after; their cells
 * arrive as `{ sharedString: n }` placeholders, so detect that and use the in-memory loader.
 */
async function readXlsx(buf: Buffer): Promise<{ header: string[]; rows: Row[] }> {
  const raw: string[][] = [];
  let unresolved = false;
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buf], { objectMode: false }), {
      worksheets: "emit",
      sharedStrings: "cache",
      styles: "cache", // needed to turn date-formatted serials back into dates
      entries: "ignore",
    });
    for await (const sheet of reader) {
      for await (const row of sheet) {
        const vals = (row.values as unknown[]).slice(1); // exceljs is 1-indexed
        const out: string[] = new Array(vals.length);
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i];
          if (v && typeof v === "object" && "sharedString" in (v as Record<string, unknown>)) unresolved = true;
          out[i] = cellToString(v);
        }
        raw.push(out);
      }
      break; // first worksheet only
    }
    if (!unresolved && raw.length > 0) return toRows(raw);
  } catch {
    // fall through to the in-memory reader
  }

  raw.length = 0;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The Excel file has no worksheets.");
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as unknown[]).slice(1);
    raw.push(Array.from({ length: vals.length }, (_, i) => cellToString(vals[i])));
  });
  return toRows(raw);
}

export async function readInput(name: string, buf: Buffer): Promise<{ header: string[]; rows: Row[] }> {
  const lower = name.toLowerCase();

  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return readXlsx(buf);

  if (lower.endsWith(".xls")) {
    throw new Error("Old .xls files are not supported - please save the sheet as .xlsx or .csv.");
  }

  // CSV (strip a UTF-8 BOM if present)
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  return toRows(parsed.data.map((r) => r.map((c) => (c ?? "").trim())));
}

function toRows(raw: string[][]): { header: string[]; rows: Row[] } {
  if (raw.length === 0) throw new Error("The input file is empty.");
  const header = raw[0].map((h) => h.trim());
  const rows: Row[] = [];
  for (const r of raw.slice(1)) {
    if (!r.some((c) => c !== "")) continue; // skip the blank ",,,,,," rows
    const row: Row = {};
    header.forEach((h, i) => (row[h] = (r[i] ?? "").trim()));
    rows.push(row);
  }
  return { header, rows };
}

/** Map case-insensitive header names to their canonical spelling, e.g. "MRBTSID" -> "mrbtsId".
 *  `aliases` maps an alternative column name (e.g. the dump spelling "pCA_csirsPower") to the
 *  canonical parameter name ("csirsPower"). */
export function canonicalize(
  header: string[],
  rows: Row[],
  canonical: string[],
  aliases: Record<string, string> = {},
): { header: string[]; rows: Row[] } {
  const lookup = new Map(canonical.map((c) => [c.toLowerCase(), c]));
  const map = new Map(header.map((h) => [h, lookup.get(h.toLowerCase()) ?? aliases[h.toLowerCase()] ?? h]));
  // One for-in pass per row - no Object.entries()/fromEntries() pair per row.
  const renamed: Row[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    const dst: Row = {};
    for (const k in src) dst[map.get(k) ?? k] = src[k];
    renamed[i] = dst;
  }
  return { header: header.map((h) => map.get(h)!), rows: renamed };
}
