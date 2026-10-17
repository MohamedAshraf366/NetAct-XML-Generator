"use client";

import { useMemo, useState } from "react";
import DropZone, { sizeLabel } from "./DropZone";
import type { Change, ConvertResponse } from "@/lib/types";
import { writeRaml } from "@/lib/xml";

const FILE_PREFIX = "Mohamed Ashraf";

const stem = (n: string) => n.replace(/\.[^.]+$/, "").split("_").pop() ?? "";

const editKey = (distName: string, param: string) => `${distName}|${param}`;

const STAT_ICONS: Record<string, string> = {
  rows: "M3 3h18v4H3zM3 10h18v4H3zM3 17h18v4H3z",
  match: "M20 6 9 17l-5-5",
  changed: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  equal: "M5 9h14M5 15h14",
};

function Stat({ label, value, icon, accent }: { label: string; value: number | string; icon: string; accent?: boolean }) {
  return (
    <div
      className={`surface p-4 ${
        accent ? "ring-1 ring-brand-500/30 dark:ring-brand-400/30" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
        <svg
          viewBox="0 0 24 24"
          className={`h-4 w-4 ${accent ? "text-brand-500 dark:text-brand-400" : "text-slate-400 dark:text-slate-500"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={icon} />
        </svg>
      </div>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent ? "text-gradient" : "text-slate-900 dark:text-white"}`}>{value}</p>
    </div>
  );
}

type ParamMeta = { techs: Array<"LTE" | "NR">; needsRelId: boolean };

const ICONS = {
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
};

function SegIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-600 to-violet-500 text-xs font-bold text-white shadow-md shadow-brand-500/25">
      {n}
    </span>
  );
}

type ManualRow = { id: number; mrbtsId: string; btsId: string; cellId: string; relId: string; values: Record<string, string> };

let rowSeq = 0;
const newManualRow = (): ManualRow => ({ id: ++rowSeq, mrbtsId: "", btsId: "", cellId: "", relId: "", values: {} });

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** One input per table column - the filters live in the header, not in a search bar. */
type ColFilter = "distName" | "cls" | "param" | "old" | "new";

const COL_FILTERS: ColFilter[] = ["distName", "cls", "param", "old", "new"];
const COL_PLACEHOLDERS: Record<ColFilter, string> = {
  distName: "Filter…",
  cls: "Filter…",
  param: "Filter…",
  old: "Filter…",
  new: "Filter…",
};
const emptyColFilters = (): Record<ColFilter, string> => ({ distName: "", cls: "", param: "", old: "", new: "" });

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button type="button" onClick={copy} className="btn-ghost !px-3 !py-1.5 text-xs">
      {done ? (
        <>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

export default function Converter({ paramNames, paramMeta }: { paramNames: string[]; paramMeta: Record<string, ParamMeta> }) {
  const [input, setInput] = useState<File[]>([]);
  const [inputMode, setInputMode] = useState<"upload" | "manual">("upload");
  const [manualTech, setManualTech] = useState<"LTE" | "NR">("LTE");
  const [manualRows, setManualRows] = useState<ManualRow[]>([newManualRow()]);
  const [db, setDb] = useState<File[]>([]);
  const [dbMode, setDbMode] = useState<"upload" | "link">("upload");
  const [links, setLinks] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResponse | null>(null);
  const [view, setView] = useState<"table" | "xml">("table");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [colFilters, setColFilters] = useState<Record<ColFilter, string>>(emptyColFilters);

  const onInput = (files: File[]) => {
    setInput(files);
    if (files[0] && !nameTouched) setName(stem(files[0].name));
  };

  const techParams = useMemo(
    () => paramNames.filter((p) => paramMeta[p]?.techs.includes(manualTech)),
    [paramNames, paramMeta, manualTech],
  );
  const needsRel = useMemo(() => techParams.some((p) => paramMeta[p]?.needsRelId), [techParams, paramMeta]);

  const setRow = (id: number, patch: Partial<ManualRow>) =>
    setManualRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const setRowValue = (id: number, p: string, v: string) =>
    setManualRows((rs) => rs.map((r) => (r.id === id ? { ...r, values: { ...r.values, [p]: v } } : r)));

  const hasDb = dbMode === "link" ? links.trim().length > 0 : db.length > 0;
  const linkEntries = links.split(/\s+/).filter(Boolean);
  const badLinkCount = linkEntries.filter((u) => !/^https?:\/\//i.test(u)).length;
  const manualHasRow = manualRows.some(
    (r) => r.mrbtsId.trim() !== "" && r.cellId.trim() !== "" && techParams.some((p) => (r.values[p] ?? "").trim() !== ""),
  );
  const canRun = (inputMode === "upload" ? input.length > 0 : manualHasRow) && !busy;

  function manualCsv(): string {
    const ids = manualTech === "NR" ? ["mrbtsId", "nrBtsId", "nrCellId"] : ["mrbtsId", "lnBtsId", "lnCelId"];
    const header = [...ids, ...(needsRel ? ["lnRelId"] : []), ...techParams];
    const lines = [header.join(",")];
    manualRows.forEach((r, idx) => {
      if (!techParams.some((p) => (r.values[p] ?? "").trim())) return; // rows without values are ignored
      if (r.mrbtsId.trim() === "" || r.cellId.trim() === "") {
        throw new Error(`Manual values: row ${idx + 1} needs an mrbtsId and a cell id.`);
      }
      lines.push(
        [
          r.mrbtsId.trim(),
          r.btsId.trim(),
          r.cellId.trim(),
          ...(needsRel ? [r.relId.trim()] : []),
          ...techParams.map((p) => (r.values[p] ?? "").trim()),
        ]
          .map(csvCell)
          .join(","),
      );
    });
    if (lines.length === 1) throw new Error("Manual values: enter a value in at least one row.");
    return lines.join("\r\n");
  }

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      if (inputMode === "upload") {
        fd.append("input", input[0]);
      } else {
        fd.append("input", new File([manualCsv()], "manual-values.csv", { type: "text/csv" }));
        techParams.forEach((p) => fd.append("params", p));
      }
      if (dbMode === "link") {
        const parts = links.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        parts.forEach((url) => fd.append("dbUrl", url));
      } else {
        db.forEach((f) => fd.append("db", f));
      }
      fd.append("name", name);
      const res = await fetch("/api/convert", { method: "POST", body: fd });
      // A large database upload can be rejected by the hosting platform (e.g. Vercel's 4.5 MB
      // request-body limit) before the route runs, which returns plain text, not JSON.
      const text = await res.text();
      let json: ConvertResponse | null = null;
      let serverError: string | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          serverError = String((parsed as { error: unknown }).error);
        } else {
          json = parsed as ConvertResponse;
        }
      } catch {
        /* not JSON - the platform answered before the route ran */
      }
      if (!res.ok) {
        if (res.status === 413) {
          throw new Error(
            "The database file is too large for this server to accept (the host limits uploads to 4.5 MB). " +
              "Run the app locally, or deploy it somewhere without that request-size limit.",
          );
        }
        throw new Error(serverError ?? (text.trim().slice(0, 300) || "Conversion failed."));
      }
      if (!json) throw new Error("The server returned an unexpected response.");
      setResult(json);
      setEdits({});
      setColFilters(emptyColFilters());
      setView("table");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const downloadFileName = result ? `${FILE_PREFIX} ${result.fileName}` : "";

  // The user can tweak any "new" value in the table; the XML preview and the download follow along.
  const effectiveChanges: Change[] = useMemo(() => {
    if (!result) return [];
    if (Object.keys(edits).length === 0) return result.changes;
    return result.changes.map((c) => ({
      ...c,
      params: c.params.map((p) => {
        const k = editKey(c.distName, p.name);
        return k in edits ? { ...p, new: edits[k] } : p;
      }),
    }));
  }, [result, edits]);

  const xml = useMemo(() => {
    if (!result) return "";
    if (Object.keys(edits).length === 0) return result.xml;
    return writeRaml(effectiveChanges, result.planName || "changes");
  }, [result, edits, effectiveChanges]);

  const visibleChanges = useMemo(() => {
    // Each header input is an independent substring filter; all active ones are AND-ed together.
    const q = (k: ColFilter) => colFilters[k].trim().toLowerCase();
    const objFilters: Array<[("distName" | "cls") & ColFilter, string]> = [
      ["distName", q("distName")],
      ["cls", q("cls")],
    ];
    const rowFilters: Array<[("param" | "old" | "new") & ColFilter, string]> = [
      ["param", q("param")],
      ["old", q("old")],
      ["new", q("new")],
    ];
    if (!objFilters.some(([, v]) => v) && !rowFilters.some(([, v]) => v)) return effectiveChanges;

    const out: Change[] = [];
    const hasRowFilter = rowFilters.some(([, v]) => v);
    for (const c of effectiveChanges) {
      const text = { distName: c.distName.toLowerCase(), cls: c.cls.toLowerCase() };
      if (objFilters.some(([k, v]) => v && !text[k].includes(v))) continue;
      if (!hasRowFilter) {
        out.push(c);
        continue;
      }
      // Row-level filters keep only the parameter rows that match, so the table shows exactly what was filtered.
      const params = c.params.filter((p) => {
        const cell = { param: p.name, old: p.old, new: p.new };
        return rowFilters.every(([k, v]) => !v || cell[k].toLowerCase().includes(v));
      });
      if (params.length > 0) out.push({ ...c, params });
    }
    return out;
  }, [effectiveChanges, colFilters]);

  const activeFilters = COL_FILTERS.some((k) => colFilters[k].trim() !== "");

  const hasEdits = Object.keys(edits).length > 0;

  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadFileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  const preview = useMemo(
    () => xml.replace(/<\/managedObject>/g, "</managedObject>\n").replace(/<managedObject /g, "  <managedObject "),
    [xml],
  );

  return (
    <div className="space-y-8">
      <section className="grid gap-6 md:grid-cols-2">
        <div className="surface p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <StepBadge n={1} />
              <div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">Planned values</p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  The values you want to apply — upload a file or type them in.
                </p>
              </div>
            </div>
            <div className="segmented">
              <button
                type="button"
                onClick={() => setInputMode("upload")}
                className={`seg-btn inline-flex items-center gap-1.5 ${inputMode === "upload" ? "seg-btn-active" : ""}`}
              >
                <SegIcon d={ICONS.upload} />
                Upload file
              </button>
              <button
                type="button"
                onClick={() => setInputMode("manual")}
                className={`seg-btn inline-flex items-center gap-1.5 ${inputMode === "manual" ? "seg-btn-active" : ""}`}
              >
                <SegIcon d={ICONS.edit} />
                Enter values
              </button>
            </div>
          </div>
          {inputMode === "upload" ? (
            <DropZone
              label=""
              title="Drop your .csv or .xlsx here"
              hint=".csv / .xlsx / .xlsm — one row per cell, columns are matched automatically"
              accept=".csv,.xlsx,.xlsm"
              files={input}
              onChange={onInput}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Technology — sets the id columns (
                  <span className="font-mono">{manualTech === "NR" ? "nrBtsId / nrCellId" : "lnBtsId / lnCelId"}</span>)
                </p>
                <div className="segmented">
                  {(["LTE", "NR"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setManualTech(t)}
                      className={`seg-btn ${manualTech === t ? "seg-btn-active" : ""}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-white/10">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
                    <tr>
                      <th className="px-2 py-2 font-medium">mrbtsId</th>
                      <th className="px-2 py-2 font-medium">{manualTech === "NR" ? "nrBtsId" : "lnBtsId"}</th>
                      <th className="px-2 py-2 font-medium">{manualTech === "NR" ? "nrCellId" : "lnCelId"}</th>
                      {needsRel && <th className="px-2 py-2 font-medium">lnRelId</th>}
                      {techParams.map((p) => (
                        <th key={p} className="px-2 py-2 font-medium">{p}</th>
                      ))}
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                    {manualRows.map((r, idx) => (
                      <tr key={r.id} className="transition hover:bg-slate-50/70 dark:hover:bg-white/[0.03]">
                        <td className="px-2 py-1.5">
                          <input
                            value={r.mrbtsId}
                            onChange={(e) => setRow(r.id, { mrbtsId: e.target.value })}
                            placeholder="419852"
                            className="field-cell"
                            aria-label={`mrbtsId, row ${idx + 1}`}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            value={r.btsId}
                            onChange={(e) => setRow(r.id, { btsId: e.target.value })}
                            placeholder="= mrbtsId"
                            className="field-cell"
                            aria-label={`BTS id, row ${idx + 1}`}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            value={r.cellId}
                            onChange={(e) => setRow(r.id, { cellId: e.target.value })}
                            placeholder="101"
                            className="field-cell"
                            aria-label={`Cell id, row ${idx + 1}`}
                          />
                        </td>
                        {needsRel && (
                          <td className="px-2 py-1.5">
                            <input
                              value={r.relId}
                              onChange={(e) => setRow(r.id, { relId: e.target.value })}
                              placeholder="361"
                              className="field-cell"
                              aria-label={`lnRelId, row ${idx + 1}`}
                            />
                          </td>
                        )}
                        {techParams.map((p) => (
                          <td key={p} className="px-2 py-1.5">
                            <input
                              value={r.values[p] ?? ""}
                              onChange={(e) => setRowValue(r.id, p, e.target.value)}
                              spellCheck={false}
                              className="field-inline"
                              aria-label={`${p}, row ${idx + 1}`}
                            />
                          </td>
                        ))}
                        <td className="px-2 py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() => setManualRows((rs) => rs.filter((x) => x.id !== r.id))}
                            className="rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                            aria-label={`Remove row ${idx + 1}`}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setManualRows((rs) => [...rs, newManualRow()])} className="btn-ghost !px-3 !py-1.5 text-xs">
                  + Add row
                </button>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Rows without values are ignored — leave btsId empty when it equals mrbtsId.
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="surface p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <StepBadge n={2} />
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
                  Database
                  <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:border-white/10 dark:text-slate-500">
                    Optional
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Compare against the current values of the network.
                </p>
              </div>
            </div>
            <div className="segmented">
              <button
                type="button"
                onClick={() => setDbMode("upload")}
                className={`seg-btn inline-flex items-center gap-1.5 ${dbMode === "upload" ? "seg-btn-active" : ""}`}
              >
                <SegIcon d={ICONS.upload} />
                Upload files
              </button>
              <button
                type="button"
                onClick={() => setDbMode("link")}
                className={`seg-btn inline-flex items-center gap-1.5 ${dbMode === "link" ? "seg-btn-active" : ""}`}
              >
                <SegIcon d={ICONS.link} />
                Link
              </button>
            </div>
          </div>
          {dbMode === "upload" ? (
            <>
              <DropZone
                label=""
                title="Drop your database export here"
                hint=".mdb, .accdb, .rar, .zip, .xml or .xml.gz — one or several files"
                accept=".rar,.zip,.mdb,.accdb,.xml,.gz"
                multiple
                files={db}
                onChange={setDb}
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  {db.length === 0
                    ? "No files selected"
                    : `${db.length} file${db.length > 1 ? "s" : ""} — ${sizeLabel(db.reduce((n, f) => n + f.size, 0))}`}
                </p>
                <button
                  type="button"
                  onClick={() => setDb([])}
                  disabled={db.length === 0}
                  className="shrink-0 text-xs text-slate-400 transition hover:text-red-600 disabled:opacity-40 disabled:hover:text-slate-400 dark:hover:text-red-400"
                >
                  Clear
                </button>
              </div>
            </>
          ) : (
            <>
              <textarea
                value={links}
                onChange={(e) => setLinks(e.target.value)}
                rows={3}
                spellCheck={false}
                className="field resize-y font-mono text-xs"
                placeholder={"https://example.com/Dump.rar\nPaste direct links to .mdb/.accdb/.rar/.zip/.xml/.xml.gz — one per line"}
              />
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                <span className="text-slate-400 dark:text-slate-500">
                  {linkEntries.length === 0
                    ? "No links yet"
                    : `${linkEntries.length} link${linkEntries.length > 1 ? "s" : ""} detected`}
                </span>
                {badLinkCount > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {badLinkCount} {badLinkCount > 1 ? "entries" : "entry"} must start with http(s)://
                  </span>
                )}
              </div>
            </>
          )}
          <div className="mt-4 space-y-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            <p>
              The generated XML contains
              <span className="font-medium text-slate-700 dark:text-slate-200"> only the differences</span> between your
              planned values and this database — exactly like a NetAct plan export.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[
                ["NetAct dump", ".mdb / .accdb"],
                ["Archive", ".rar / .zip"],
                ["RAML export", ".xml / .xml.gz"],
              ].map(([k, v]) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/60 px-2 py-1 dark:border-white/10 dark:bg-white/[0.03]"
                >
                  <span className="font-medium text-slate-600 dark:text-slate-300">{k}</span>
                  <span className="font-mono text-[11px] text-brand-600 dark:text-brand-400">{v}</span>
                </span>
              ))}
            </div>
            <p>
              Links are downloaded by the server, so hosting upload limits do not apply. Uploaded archives are unpacked
              automatically and only the needed cells are read. Files are processed for this request only and are never
              stored.
            </p>
            <p className="text-brand-600 dark:text-brand-400">
              Optional — leave this empty to write every planned value as an update.
            </p>
          </div>
        </div>
      </section>

      <section className="surface grid gap-6 p-5 md:grid-cols-[1fr_auto] md:items-end">
        <div className="max-w-sm">
          <label htmlFor="name" className="mb-1.5 block text-sm font-semibold text-slate-800 dark:text-slate-200">
            Plan name (output file)
          </label>
          <div className="flex items-center gap-2">
            <input
              id="name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="700"
              className="field text-sm"
            />
            <span className="text-sm text-slate-500 dark:text-slate-400">.xml</span>
          </div>
        </div>
        <button onClick={run} disabled={!canRun} className="btn-primary w-full md:w-auto">
          {busy ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              {hasDb ? "Comparing…" : "Generating…"}
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
              </svg>
              {hasDb ? "Compare & generate XML" : "Generate XML (all values)"}
            </>
          )}
        </button>
      </section>

      {error && (
        <p className="animate-fade-up whitespace-pre-line rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {result && (
        <section className="animate-fade-up space-y-5">
          <div className="surface flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 text-xs text-slate-500 dark:text-slate-400">
            <p>
              Compared:{" "}
              <span className="font-medium text-slate-700 dark:text-slate-200">{result.stats.comparedParams.join(", ")}</span>
            </p>
            <p className="min-w-0 flex-1 truncate">
              Database:{" "}
              <span className="text-slate-600 dark:text-slate-300">
                {result.dbSources.map((d) => `${d.name} (${(d.bytes / 1048576).toFixed(1)} MB)`).join(", ")}
              </span>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Rows read" value={result.stats.inputRows} icon={STAT_ICONS.rows} />
            <Stat label="Matched in database" value={result.stats.dbObjectsMatched} icon={STAT_ICONS.match} />
            <Stat label="Changed objects" value={result.stats.changedObjects} icon={STAT_ICONS.changed} accent />
            <Stat label="Values already equal" value={result.stats.unchangedValues} icon={STAT_ICONS.equal} />
          </div>

          {result.warnings.length > 0 && (
            <details className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
              <summary className="cursor-pointer font-medium">{result.warnings.length} warning(s)</summary>
              <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-auto pl-5 font-mono text-xs">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="segmented">
              {(["table", "xml"] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} className={`seg-btn ${view === v ? "seg-btn-active" : ""}`}>
                  {v === "table" ? "Changes" : "XML preview"}
                </button>
              ))}
            </div>

            {view === "table" && activeFilters && (
              <button
                type="button"
                onClick={() => setColFilters(emptyColFilters())}
                className="btn-ghost !px-3 !py-1.5 text-xs"
                title="Clear all column filters"
              >
                Clear filters
              </button>
            )}

            <div className="ml-auto flex items-center gap-2">
              {hasEdits && (
                <button onClick={() => setEdits({})} className="btn-ghost !px-3 !py-1.5 text-xs" title="Discard manual edits">
                  Reset edits
                </button>
              )}
              <button onClick={download} disabled={effectiveChanges.length === 0} className="btn-primary">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                Download
              </button>
            </div>
          </div>

          {result.changes.length === 0 ? (
            <p className="surface px-4 py-10 text-center text-sm text-slate-600 dark:text-slate-400">
              Nothing to change — every value in the CSV already matches the database.
            </p>
          ) : view === "table" ? (
            <div className="surface overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-white/10 dark:text-slate-400">
                  <tr>
                    <th className="px-4 pt-3 font-medium">distName</th>
                    <th className="px-4 pt-3 font-medium">Class</th>
                    <th className="px-4 pt-3 font-medium">Parameter</th>
                    <th className="px-4 pt-3 text-right font-medium">Database</th>
                    <th className="px-4 pt-3 text-right font-medium">New</th>
                  </tr>
                  <tr className="normal-case tracking-normal">
                    {(["distName", "cls", "param", "old", "new"] as ColFilter[]).map((key) => (
                      <th key={key} className="px-4 pb-3 pt-1.5 font-normal">
                        <input
                          value={colFilters[key]}
                          onChange={(e) => setColFilters((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder={COL_PLACEHOLDERS[key]}
                          spellCheck={false}
                          aria-label={`Filter ${key === "old" ? "database value" : key === "cls" ? "class" : key === "new" ? "new value" : key}`}
                          className="field w-full !py-1 text-xs"
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                  {visibleChanges.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-600 dark:text-slate-400">
                        {activeFilters ? "No cells match the current filters." : "No cells match."}
                      </td>
                    </tr>
                  )}
                  {visibleChanges.flatMap((c) =>
                    c.params.map((p) => {
                      const k = editKey(c.distName, p.name);
                      const edited = k in edits;
                      return (
                        <tr key={c.distName + p.name} className="transition hover:bg-slate-50/70 dark:hover:bg-white/[0.03]">
                          <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">
                            {c.distName.replace("PLMN-PLMN/", "")}
                          </td>
                          <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">{c.cls.replace("NOKLTE:", "")}</td>
                          <td className="px-4 py-2 text-slate-700 dark:text-slate-200">{p.name}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-slate-400 dark:text-slate-500">
                            {p.old === "" ? <em>not set</em> : <span className="line-through">{p.old}</span>}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <input
                              value={edited ? edits[k] : p.new}
                              onChange={(e) => setEdits((prev) => ({ ...prev, [k]: e.target.value }))}
                              spellCheck={false}
                              title={
                                p.filler
                                  ? "Unchanged — kept from the database so the whole list is written"
                                  : p.derived
                                    ? "Set automatically: csirsPower − 3"
                                    : "Edit this value"
                              }
                              aria-label={`Value for ${p.name} on ${c.distName}`}
                              className={`field-inline ${edited ? "ring-2 ring-amber-400/70" : ""}`}
                            />
                          </td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="surface overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/10 bg-slate-900/60 px-4 py-2">
                <span className="flex items-center gap-2 font-mono text-xs text-slate-400">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
                  <span className="ml-2">{downloadFileName}</span>
                </span>
                <CopyButton text={result.xml} />
              </div>
              <pre className="max-h-[32rem] overflow-auto bg-[#0b1020] p-4 font-mono text-xs leading-relaxed text-slate-200">{preview}</pre>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
