import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { ALL_PARAM_NAMES, PARAM_ALIASES, defaultParamNamesFor, paramsFor, type ParamDef, type Tech } from "@/lib/config";
import { buildChanges, dbParamNames, wantedDistNames } from "@/lib/diff";
import { loadDb, type DbObject } from "@/lib/db";
import { fetchDb } from "@/lib/fetchDb";
import { canonicalize, readInput } from "@/lib/input";
import { releaseMemorySoon } from "@/lib/mem";
import type { ConvertResponse, DbSource } from "@/lib/types";
import { isUploadId, removeUploads, uploadPath } from "@/lib/uploads";
import { writeRaml } from "@/lib/xml";

export const runtime = "nodejs";
export const maxDuration = 300;

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Identity columns, never treated as parameters. */
const ID_COLUMNS = ["mrbtsId", "lnBtsId", "lnCelId", "lnRelId", "nrBtsId", "nrCellId"];

async function toBuffer(f: File) {
  return Buffer.from(await f.arrayBuffer());
}

/** First bytes of a file on disk, enough to detect its format. */
async function readPrefix(filePath: string, n: number): Promise<Buffer> {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function POST(req: Request) {
  const uploadedIds: string[] = [];
  try {
    const form = await req.formData();

    const input = form.get("input");
    const dbFiles = form.getAll("db").filter((f): f is File => f instanceof File && f.size > 0);
    if (!(input instanceof File) || input.size === 0) return fail("Please choose the CSV / Excel file.");
    const links = form
      .getAll("dbUrl")
      .flatMap((v) => String(v).split(/\s+/))
      .filter(Boolean);
    if (links.length > 5) return fail("Please give at most 5 database links.");

    // Large files arrive in chunks via /api/upload; "dbRef" is "<uploadId>|<original name>".
    // Register them for cleanup immediately so the temp files are removed even if validation fails.
    const dbRefs: { name: string; path: string }[] = [];
    for (const ref of form.getAll("dbRef").map(String)) {
      const sep = ref.indexOf("|");
      const id = sep === -1 ? ref : ref.slice(0, sep);
      const refName = (sep === -1 ? "" : ref.slice(sep + 1)) || "database.bin";
      if (!isUploadId(id)) return fail("Invalid database reference.");
      uploadedIds.push(id);
      dbRefs.push({ name: refName, path: uploadPath(id) });
    }

    // Manual mapping fallback support:
    // e.g. mappings='{"customParam": {"cls": "NOKLTE:LNCEL", "suffix": "", "defaultOn": true}}'
    const customMappingRaw = form.get("customMapping") ?? form.get("mappings");
    const customMappings: Record<string, ParamDef> = {};
    if (customMappingRaw && typeof customMappingRaw === "string") {
      try {
        const parsed = JSON.parse(customMappingRaw);
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v === "object" && "cls" in v && "suffix" in v) {
            customMappings[k] = {
              cls: String((v as { cls: string }).cls),
              suffix: String((v as { suffix: string }).suffix),
              defaultOn: Boolean((v as { defaultOn?: boolean }).defaultOn ?? false),
            };
          }
        }
      } catch {
        /* ignore invalid JSON */
      }
    }

    const rawName = String(form.get("name") ?? "").trim();
    const name = rawName || "changes"; // plan name inside the XML, exactly as typed
    const fileBase = name.replace(/[^\w.-]+/g, "_");

    // 1. read the CSV / Excel (recognising both LTE and NR column names)
    const parsed = await readInput(input.name, await toBuffer(input));
    const { header, rows } = canonicalize(parsed.header, parsed.rows, [...ID_COLUMNS, ...ALL_PARAM_NAMES], PARAM_ALIASES);
    for (const col of ["mrbtsId"]) {
      if (!header.includes(col)) return fail(`Column "${col}" was not found in the input file.`);
    }
    // Require at least one of the cell identity columns (lnCelId or nrCellId)
    if (!header.includes("lnCelId") && !header.includes("nrCellId")) {
      return fail(`Column "lnCelId" or "nrCellId" was not found in the input file.`);
    }

    // The technology decides which parameter -> class map applies (a few names, e.g. "angle",
    // exist in both LTE and NR but target different managed objects).
    const tech: Tech = header.includes("nrCellId") ? "NR" : "LTE";
    // TDD exports use a different child object for dlRsBoost (LNCEL_TDD instead of LNCEL_FDD).
    const tdd = tech === "LTE" && (header.includes("dlSectorBFWeightProfName") || header.includes("mMimoSectorBFProfName"));
    const activeParamDefs: Record<string, ParamDef> = { ...paramsFor(tech), ...customMappings };
    const allKnownParamNames = Object.keys(activeParamDefs);

    // Fallback: an unrecognised header column is mapped to this technology's base cell class.
    for (const col of header) {
      if (!ID_COLUMNS.includes(col) && !activeParamDefs[col]) {
        activeParamDefs[col] =
          tech === "NR"
            ? { cls: "com.nokia.srbts.nrbts:NRCELL", suffix: "", defaultOn: false, tech: "NR" }
            : { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: false, tech: "LTE" };
      }
    }

    const requested = form
      .getAll("params")
      .map(String)
      .filter((p) => p in activeParamDefs);
    const defaultNames = defaultParamNamesFor(tech).filter((p) => activeParamDefs[p]);
    const params = (requested.length ? requested : defaultNames).filter((p) => header.includes(p));
    if (params.length === 0) return fail(`None of the parameter columns (${allKnownParamNames.join(", ")}) were found in the input file.`);

    // 2. get the database (uploaded files and / or pasted links), then read only the cells we need.
    //    With no database at all every planned value is written straight out as an update.
    const sources: { name: string; data: Buffer; path?: string; bytes?: number }[] = [];
    const dbSources: DbSource[] = [];
    for (const f of dbFiles) {
      const data = await toBuffer(f);
      sources.push({ name: f.name, data });
      dbSources.push({ name: f.name, bytes: data.length, from: "upload" });
    }
    // Large files arrive in chunks via /api/upload; "dbRef" is "<uploadId>|<original name>".
    for (const ref of dbRefs) {
      const st = await fsp.stat(ref.path).catch(() => null);
      if (!st?.isFile()) return fail("The uploaded database file was not found on the server. Please retry the upload.");
      // Only a small prefix is read here: `ingest` detects the format from it and streams the rest
      // from disk, so a 1.3 GB .mdb is never copied into RAM.
      const prefix = await readPrefix(ref.path, 64);
      sources.push({ name: ref.name, data: prefix, path: ref.path, bytes: st.size });
      dbSources.push({ name: ref.name, bytes: st.size, from: "upload" });
    }
    for (const link of links) {
      try {
        const got = await fetchDb(link);
        sources.push({ name: got.name, data: got.data, path: got.path, bytes: got.bytes });
        dbSources.push({ name: got.name, bytes: got.bytes ?? got.data.length, from: "link" });
      } catch (e) {
        const short = link.length > 70 ? `${link.slice(0, 67)}...` : link;
        return fail(`Could not download the database from ${short}\n${e instanceof Error ? e.message : "Unknown error."}`);
      }
    }

    let dbObjects: Map<string, DbObject> | null = null;
    let dbFilesRead = 0;
    let dbScanned = 0;
    if (sources.length > 0) {
      const wanted = wantedDistNames(rows, params, activeParamDefs, tdd);
      const db = await loadDb(sources, wanted, dbParamNames(params, activeParamDefs));
      if (db.filesRead === 0) return fail("No .xml or .mdb database files were found inside the database upload.");
      dbObjects = db.objects;
      dbFilesRead = db.filesRead;
      dbScanned = db.scanned;
    }

    // 3. compare + write
    const { changes, warnings, unchanged } = buildChanges(rows, params, dbObjects, activeParamDefs, tdd);
    if (!dbObjects) warnings.unshift("No database was provided - all planned values were written as updates.");
    const xml = writeRaml(changes, name);

    const body: ConvertResponse = {
      xml,
      fileName: `${fileBase}.xml`,
      planName: name,
      dbSources,
      changes,
      warnings: warnings.slice(0, 200),
      stats: {
        inputRows: rows.length,
        comparedParams: params,
        dbFiles: dbFilesRead,
        dbObjectsScanned: dbScanned,
        dbObjectsMatched: dbObjects?.size ?? 0,
        changedObjects: changes.length,
        changedValues: changes.reduce((n, c) => n + c.params.filter((p) => !p.filler).length, 0),
        unchangedValues: unchanged,
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    console.error(e);
    return fail(e instanceof Error ? e.message : "Conversion failed.", 500);
  } finally {
    await removeUploads(uploadedIds);
    releaseMemorySoon();
  }
}
