"use client";

import { useMemo, useState } from "react";
import DropZone from "./DropZone";
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

export default function Converter({ paramNames, defaultParams }: { paramNames: string[]; defaultParams: string[] }) {
  const [input, setInput] = useState<File[]>([]);
  const [db, setDb] = useState<File[]>([]);
  const [dbMode, setDbMode] = useState<"link" | "upload">("link");
  const [links, setLinks] = useState("");
  const [params, setParams] = useState<string[]>(defaultParams);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResponse | null>(null);
  const [view, setView] = useState<"table" | "xml">("table");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");

  const onInput = (files: File[]) => {
    setInput(files);
    if (files[0] && !nameTouched) setName(stem(files[0].name));
  };

  const toggle = (p: string) => setParams((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  const hasDb = dbMode === "link" ? links.trim().length > 0 : db.length > 0;
  const canRun = input.length > 0 && params.length > 0 && !busy;

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("input", input[0]);
      if (dbMode === "link") {
        fd.append("dbUrl", links);
      } else {
        db.forEach((f) => fd.append("db", f));
      }
      params.forEach((p) => fd.append("params", p));
      fd.append("name", name);
      const res = await fetch("/api/convert", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Conversion failed.");
      setResult(json as ConvertResponse);
      setEdits({});
      setQuery("");
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
    const q = query.trim().toLowerCase();
    if (!q) return effectiveChanges;
    return effectiveChanges.filter(
      (c) =>
        c.distName.toLowerCase().includes(q) ||
        c.cls.toLowerCase().includes(q) ||
        c.params.some(
          (p) => p.name.toLowerCase().includes(q) || p.new.toLowerCase().includes(q) || p.old.toLowerCase().includes(q),
        ),
    );
  }, [effectiveChanges, query]);

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
          <DropZone label="1. Planned values" hint=".csv or .xlsx" accept=".csv,.xlsx,.xlsm" files={input} onChange={onInput} />
        </div>
        <div className="surface p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">2. Database</p>
            <div className="segmented">
              {(["link", "upload"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDbMode(m)}
                  className={`seg-btn ${dbMode === m ? "seg-btn-active" : ""}`}
                >
                  {m === "link" ? "Paste link" : "Upload file"}
                </button>
              ))}
            </div>
          </div>
          {dbMode === "link" ? (
            <div>
              <textarea
                value={links}
                onChange={(e) => setLinks(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="The link for updated Dump"
                className="field resize-y font-mono text-xs"
              />
              <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Google Drive link (shared as “Anyone with the link”) or a direct link to a .rar / .zip / .mdb / .xml file. Use a new
                link any time - it is downloaded fresh on every run. One link per line.
              </p>
              {!hasDb && (
                <p className="mt-2 text-xs leading-relaxed text-brand-600 dark:text-brand-400">
                  Optional — leave this empty to skip the comparison and write every planned value as an update.
                </p>
              )}
            </div>
          ) : (
            <DropZone
              label=""
              hint=".rar, .zip, .mdb, .accdb, .xml or .xml.gz — one or several files"
              accept=".rar,.zip,.mdb,.accdb,.xml,.gz"
              multiple
              files={db}
              onChange={setDb}
            />
          )}
        </div>
      </section>

      <section className="surface grid gap-6 p-5 md:grid-cols-[1fr_auto] md:items-end">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200">Parameters to compare</p>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">Columns that are not in your file are ignored automatically.</p>
            <div className="flex flex-wrap gap-2">
              {paramNames.map((p) => (
                <label key={p} className={`chip ${params.includes(p) ? "chip-on" : "chip-off"}`}>
                  <input type="checkbox" className="sr-only" checked={params.includes(p)} onChange={() => toggle(p)} />
                  {p}
                </label>
              ))}
            </div>
          </div>
          <div>
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
        </div>
        <button onClick={run} disabled={!canRun} className="btn-primary w-full md:w-auto">
          {busy ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              {dbMode === "link" ? "Downloading & comparing…" : "Comparing…"}
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
                {result.dbSources
                  .map((d) => `${d.name} (${(d.bytes / 1048576).toFixed(1)} MB, ${d.from === "link" ? "from link" : "uploaded"})`)
                  .join(", ")}
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

            {view === "table" && (
              <div className="relative min-w-[12rem] flex-1">
                <svg
                  viewBox="0 0 24 24"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search cell, parameter or value…"
                  spellCheck={false}
                  className="field pl-9 text-sm"
                  aria-label="Search cells"
                />
              </div>
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
                    <th className="px-4 py-3 font-medium">distName</th>
                    <th className="px-4 py-3 font-medium">Class</th>
                    <th className="px-4 py-3 font-medium">Parameter</th>
                    <th className="px-4 py-3 text-right font-medium">Database</th>
                    <th className="px-4 py-3 text-right font-medium">New</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                  {visibleChanges.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-600 dark:text-slate-400">
                        No cells match “{query}”.
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
                              title="Edit this value"
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
