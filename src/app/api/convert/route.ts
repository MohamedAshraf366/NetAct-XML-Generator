import { NextResponse } from "next/server";
import { DEFAULT_PARAM_NAMES, PARAMS, PARAM_NAMES, type ParamDef } from "@/lib/config";
import { buildChanges, wantedDistNames } from "@/lib/diff";
import { loadDb, type DbObject } from "@/lib/db";
import { fetchDb } from "@/lib/fetchDb";
import { canonicalize, readInput } from "@/lib/input";
import type { ConvertResponse, DbSource } from "@/lib/types";
import { writeRaml } from "@/lib/xml";

export const runtime = "nodejs";
export const maxDuration = 300;

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

async function toBuffer(f: File) {
  return Buffer.from(await f.arrayBuffer());
}

export async function POST(req: Request) {
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

    const activeParamDefs = { ...PARAMS, ...customMappings };
    const allKnownParamNames = Object.keys(activeParamDefs);

    const requested = form
      .getAll("params")
      .map(String)
      .filter((p) => p in activeParamDefs);
    const rawName = String(form.get("name") ?? "").trim();
    const name = rawName || "changes"; // plan name inside the XML, exactly as typed
    const fileBase = name.replace(/[^\w.-]+/g, "_");

    // 1. read the CSV / Excel
    const parsed = await readInput(input.name, await toBuffer(input));
    const { header, rows } = canonicalize(parsed.header, parsed.rows, ["mrbtsId", "lnBtsId", "lnCelId", ...allKnownParamNames]);
    for (const col of ["mrbtsId", "lnCelId"]) {
      if (!header.includes(col)) return fail(`Column "${col}" was not found in the input file.`);
    }

    // Fallback: If a header column is not in activeParamDefs but was requested, or if none matched,
    // allow unrecognized parameter columns from CSV to fall back to NOKLTE:LNCEL
    for (const col of header) {
      if (!["mrbtsId", "lnBtsId", "lnCelId"].includes(col) && !activeParamDefs[col]) {
        // Fallback mapping: treat unknown LTE cell parameter as NOKLTE:LNCEL
        activeParamDefs[col] = { cls: "NOKLTE:LNCEL", suffix: "", defaultOn: false };
      }
    }

    const defaultNames = Object.keys(activeParamDefs).filter((k) => activeParamDefs[k].defaultOn);
    const params = (requested.length ? requested : defaultNames).filter((p) => header.includes(p));
    if (params.length === 0) return fail(`None of the parameter columns (${allKnownParamNames.join(", ")}) were found in the input file.`);

    // 2. get the database (uploaded files and / or pasted links), then read only the cells we need.
    //    With no database at all every planned value is written straight out as an update.
    const sources: { name: string; data: Buffer }[] = [];
    const dbSources: DbSource[] = [];
    for (const f of dbFiles) {
      const data = await toBuffer(f);
      sources.push({ name: f.name, data });
      dbSources.push({ name: f.name, bytes: data.length, from: "upload" });
    }
    for (const link of links) {
      try {
        const got = await fetchDb(link);
        sources.push(got);
        dbSources.push({ name: got.name, bytes: got.data.length, from: "link" });
      } catch (e) {
        const short = link.length > 70 ? `${link.slice(0, 67)}...` : link;
        return fail(`Could not download the database from ${short}\n${e instanceof Error ? e.message : "Unknown error."}`);
      }
    }

    let dbObjects: Map<string, DbObject> | null = null;
    let dbFilesRead = 0;
    let dbScanned = 0;
    if (sources.length > 0) {
      const wanted = wantedDistNames(rows, params, activeParamDefs);
      const db = await loadDb(sources, wanted);
      if (db.filesRead === 0) return fail("No .xml or .mdb database files were found inside the database upload.");
      dbObjects = db.objects;
      dbFilesRead = db.filesRead;
      dbScanned = db.scanned;
    }

    // 3. compare + write
    const { changes, warnings, unchanged } = buildChanges(rows, params, dbObjects, activeParamDefs);
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
        changedValues: changes.reduce((n, c) => n + c.params.length, 0),
        unchangedValues: unchanged,
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    console.error(e);
    return fail(e instanceof Error ? e.message : "Conversion failed.", 500);
  }
}
