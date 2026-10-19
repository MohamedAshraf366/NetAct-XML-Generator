import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { fetchDb } from "@/lib/fetchDb";
import { ingest } from "@/lib/archive";
import { inspectXmlStream } from "@/lib/xmlscan";
import { releaseMemorySoon } from "@/lib/mem";
import { isUploadId, removeUploads, uploadPath } from "@/lib/uploads";
import { NR_PARAMS, PARAM_NAMES, PARAMS } from "@/lib/config";
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
      } else if (/NRCELL/i.test(tName) && !/NRADJNRCELL/i.test(tName)) {
        matchedRole = "NRCELL (5G Cell Config)";
        moClass = "com.nokia.srbts.nrbts:NRCELL";
      }

      const nrColToParam = new Map<string, string>();
      for (const [name, def] of Object.entries(NR_PARAMS)) {
        nrColToParam.set(name, name);
        if (def.dbColumn) nrColToParam.set(def.dbColumn, name);
      }
      const targetParams =
        moClass === "com.nokia.srbts.nrbts:NRCELL"
          ? cols.filter((c) => nrColToParam.has(c)).map((c) => nrColToParam.get(c)!)
          : cols.filter((c) => PARAM_NAMES.includes(c));
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

/**
 * Inspect a RAML document from its byte stream - a multi-GB export is walked chunk by chunk and
 * never held in memory.
 */
async function inspectXml(
  source: AsyncIterable<Buffer | Uint8Array>,
  sourceName: string,
  bytes: number,
): Promise<DatabaseInspection> {
  const found = await inspectXmlStream(source);

  const detectedParameters: { name: string; moClass: string; table: string }[] = [];
  for (const p of found.params) {
    if (p in PARAMS) detectedParameters.push({ name: p, moClass: PARAMS[p].cls, table: "RAML XML" });
    else if (p in NR_PARAMS) detectedParameters.push({ name: p, moClass: NR_PARAMS[p].cls, table: "RAML XML" });
  }

  return {
    sourceName,
    kind: "xml",
    bytes,
    xmlObjectsScanned: found.objectsScanned,
    xmlClassesFound: found.classes,
    detectedParameters,
  };
}

async function inspectBuffer(name: string, data: Buffer): Promise<DatabaseInspection[]> {
  const results: DatabaseInspection[] = [];
  await ingest(name, data, {
    xml: async (source, sourceName, bytes) => {
      results.push(await inspectXml(source, sourceName, bytes));
    },
    mdb: (mdbData, mdbName) => {
      results.push(inspectMdb(mdbData, mdbName));
    },
  });
  return results;
}

export async function POST(req: Request) {
  const uploadedIds: string[] = [];
  try {
    const form = await req.formData();
    const dbFiles = form.getAll("db").filter((f): f is File => f instanceof File && f.size > 0);
    const links = form
      .getAll("dbUrl")
      .flatMap((v) => String(v).split(/\s+/))
      .filter(Boolean);
    // Chunked uploads (see /api/upload): "dbRef" is "<uploadId>|<original name>".
    const dbRefs: { name: string; path: string }[] = [];
    for (const ref of form.getAll("dbRef").map(String)) {
      const sep = ref.indexOf("|");
      const id = sep === -1 ? ref : ref.slice(0, sep);
      const refName = (sep === -1 ? "" : ref.slice(sep + 1)) || "database.bin";
      if (!isUploadId(id)) return fail("Invalid database reference.");
      uploadedIds.push(id);
      dbRefs.push({ name: refName, path: uploadPath(id) });
    }

    if (dbFiles.length === 0 && links.length === 0 && dbRefs.length === 0) {
      return fail("Please upload a database file or provide a database link.");
    }

    const inspections: DatabaseInspection[] = [];

    for (const f of dbFiles) {
      const data = await toBuffer(f);
      const res = await inspectBuffer(f.name, data);
      inspections.push(...res);
    }

    for (const ref of dbRefs) {
      const data = await fsp.readFile(ref.path).catch(() => null);
      if (!data) return fail("The uploaded database file was not found on the server. Please retry the upload.");
      const res = await inspectBuffer(ref.name, data);
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
  } finally {
    await removeUploads(uploadedIds);
    releaseMemorySoon();
  }
}
