import Papa from "papaparse";
import ExcelJS from "exceljs";
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

export async function readInput(name: string, buf: Buffer): Promise<{ header: string[]; rows: Row[] }> {
  const lower = name.toLowerCase();

  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("The Excel file has no worksheets.");
    const raw: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as unknown[]).slice(1); // exceljs is 1-indexed
      raw.push(Array.from({ length: vals.length }, (_, i) => cellToString(vals[i])));
    });
    return toRows(raw);
  }

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

/** Map case-insensitive header names to their canonical spelling, e.g. "MRBTSID" -> "mrbtsId". */
export function canonicalize(header: string[], rows: Row[], canonical: string[]): { header: string[]; rows: Row[] } {
  const lookup = new Map(canonical.map((c) => [c.toLowerCase(), c]));
  const map = new Map(header.map((h) => [h, lookup.get(h.toLowerCase()) ?? h]));
  return {
    header: header.map((h) => map.get(h)!),
    rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [map.get(k) ?? k, v]))),
  };
}
