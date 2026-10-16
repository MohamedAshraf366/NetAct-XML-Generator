import { NextResponse } from "next/server";
import { fetchDb } from "@/lib/fetchDb";
import { kindOf } from "@/lib/db";
import { PARAM_NAMES, PARAMS } from "@/lib/config";
import JSZip from "jszip";
import { gunzipSync } from "node:zlib";
import { createExtractorFromData } from "node-unrar-js";
import MDBReader from "mdb-reader";

export const runtime = "nodejs";
export const maxDuration = 300;

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

async function toBuffer(f: File) {
  return Buffer.from(await f.arrayBuffer());
}

export type TableInfo = {
  name: string;
  rowCount: number;
  columnCount: number;
  matchedRole?: string;
  moClass?: string;
  targetParams?: string[];
  allColumns?: string[];
};

export type DatabaseInspection = {
  sourceName: string;
  kind: string;
  bytes: number;
  tables?: TableInfo[];
  detectedParameters?: { name: string; moClass: string; table: string }[];
  xmlObjectsScanned?: number;
  xmlClassesFound?: string[];
};

function inspectMdb(data: Buffer, sourceName: string): DatabaseInspection {
  const reader = new MDBReader(data);
  const tableNames = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });

  const tables: TableInfo[] = [];
  const detectedParameters: { name: string; moClass: string; table: string }[] = [];

  for (const tName of tableNames) {
    // Only include tables relevant to LTE or with > 0 rows
    const isRelevant = /cel|bts|lte|cell|plan|fdd|tdd|pc/i.test(tName);
    if (!isRelevant && !tName.startsWith("A_")) continue;

    try {
      const table = reader.getTable(tName);
      if (table.rowCount === 0) continue;

      const cols = table.getColumnNames();
      let matchedRole: string | undefined;
      let moClass: string | undefined;

      if (/^(?:[A-Z]_)?(?:LTE_MRBTS_LNBTS_)?LNCEL$/i.test(tName) || /_LNCEL$/i.test(tName)) {
        matchedRole = "LNCEL (Cell Config)";
        moClass = "NOKLTE:LNCEL";
      } else if (/LNCEL_FDD$/i.test(tName) || /LNCEL_LNCEL_FDD$/i.test(tName)) {
        matchedRole = "LNCEL_FDD (FDD Parameters)";
        moClass = "NOKLTE:LNCEL_FDD";
      } else if (/LNCEL_TDD$/i.test(tName) || /LNCEL_LNCEL_TDD$/i.test(tName)) {
        matchedRole = "LNCEL_TDD (TDD Parameters)";
        moClass = "NOKLTE:LNCEL_TDD";
      } else if (/LNCEL_PC$/i.test(tName)) {
        matchedRole = "LNCEL_PC (Power Control)";
        moClass = "NOKLTE:LNCEL";
      }

      const targetParams = cols.filter((c) => PARAM_NAMES.includes(c));
      if (moClass) {
        for (const p of targetParams) {
          detectedParameters.push({ name: p, moClass, table: tName });
        }
      }

      tables.push({
        name: tName,
        rowCount: table.rowCount,
        columnCount: table.columnCount,
        matchedRole,
        moClass,
        targetParams: targetParams.length > 0 ? targetParams : undefined,
        allColumns: cols.length < 50 ? cols : cols.slice(0, 30),
      });
    } catch {
      // Ignore tables that cannot be read
    }
  }

  return {
    sourceName,
    kind: "mdb",
    bytes: data.length,
    tables: tables.sort((a, b) => (b.matchedRole ? 1 : 0) - (a.matchedRole ? 1 : 0)),
    detectedParameters,
  };
}

function inspectXml(xmlText: string, sourceName: string, bytes: number): DatabaseInspection {
  const classesFound = new Set<string>();
  let count = 0;
  for (const m of xmlText.matchAll(/<managedObject\b[^>]*\bclass="([^"]+)"/g)) {
    classesFound.add(m[1]);
    count++;
  }
  const paramsFound = new Set<string>();
  for (const m of xmlText.matchAll(/<p\b[^>]*\bname="([^"]+)"/g)) {
    paramsFound.add(m[1]);
  }

  const detectedParameters: { name: string; moClass: string; table: string }[] = [];
  for (const p of paramsFound) {
    if (p in PARAMS) {
      detectedParameters.push({ name: p, moClass: PARAMS[p].cls, table: "RAML XML" });
    }
  }

  return {
    sourceName,
    kind: "xml",
    bytes,
    xmlObjectsScanned: count,
    xmlClassesFound: [...classesFound],
    detectedParameters,
  };
}

async function inspectBuffer(name: string, data: Buffer, depth = 0): Promise<DatabaseInspection[]> {
  if (depth > 4) return [];
  const kind = kindOf(name, data);
  const results: DatabaseInspection[] = [];

  if (kind === "mdb") {
    results.push(inspectMdb(data, name));
  } else if (kind === "xml") {
    results.push(inspectXml(data.toString("utf8"), name, data.length));
  } else if (kind === "gz") {
    return inspectBuffer(name.replace(/\.gz$/i, ""), gunzipSync(data), depth + 1);
  } else if (kind === "zip") {
    const zip = await JSZip.loadAsync(data);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const subData = Buffer.from(await entry.async("uint8array"));
      const subs = await inspectBuffer(entry.name, subData, depth + 1);
      results.push(...subs);
    }
  } else if (kind === "rar") {
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const extractor = await createExtractorFromData({ data: ab });
    const { files } = extractor.extract({ files: (h) => /\.(xml|zip|gz|rar|mdb|accdb)$/i.test(h.name) });
    for (const f of files) {
      if (f.fileHeader.flags.directory || !f.extraction) continue;
      const subData = Buffer.from(f.extraction);
      const subs = await inspectBuffer(f.fileHeader.name, subData, depth + 1);
      results.push(...subs);
    }
  }

  return results;
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const dbFiles = form.getAll("db").filter((f): f is File => f instanceof File && f.size > 0);
    const links = form
      .getAll("dbUrl")
      .flatMap((v) => String(v).split(/\s+/))
      .filter(Boolean);

    if (dbFiles.length === 0 && links.length === 0) {
      return fail("Please upload a database file or provide a database link.");
    }

    const inspections: DatabaseInspection[] = [];

    for (const f of dbFiles) {
      const data = await toBuffer(f);
      const res = await inspectBuffer(f.name, data);
      inspections.push(...res);
    }

    for (const link of links) {
      try {
        const got = await fetchDb(link);
        const res = await inspectBuffer(got.name, got.data);
        inspections.push(...res);
      } catch (e) {
        return fail(`Could not fetch link ${link}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return NextResponse.json({ inspections });
  } catch (e) {
    console.error("Inspection error:", e);
    return fail(e instanceof Error ? e.message : "Inspection failed.", 500);
  }
}
