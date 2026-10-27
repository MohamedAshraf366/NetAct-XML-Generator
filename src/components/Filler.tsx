"use client";

import { useEffect, useState } from "react";
import DropZone, { sizeLabel } from "./DropZone";

const CHUNK = 8 * 1024 * 1024;

type JobView = {
  id: string;
  phase: "queued" | "prepare" | "fill" | "zip" | "done" | "error" | "cancelled";
  queuePosition: number | null;
  xmlName: string;
  templateName: string;
  bytes: number;
  totalBytes: number;
  objects: number;
  rows: number;
  elapsedSeconds: number;
  etaSeconds: number | null;
  error: string | null;
  downloadUrl: string | null;
  zipName: string | null;
  result: {
    objects: number;
    rows: number;
    errors: number;
    sizeMB: number;
    seconds: number;
    exportTime: string | null;
    errorSamples: string[];
    errorTables: [string, number][];
    unknownLists: [string, number][];
  } | null;
};

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "");

async function upload(file: File, label: string, onProgress: (s: string) => void): Promise<string> {
  const id = newId();
  let sent = 0;
  while (sent < file.size) {
    const end = Math.min(sent + CHUNK, file.size);
    onProgress(`Uploading ${label} — ${Math.round((sent / file.size) * 100)}%`);
    const fd = new FormData();
    fd.append("id", id);
    fd.append("chunk", file.slice(sent, end), file.name);
    let res: Response;
    try {
      res = await fetch("/api/upload", { method: "POST", body: fd });
    } catch {
      throw new Error(`The upload of ${file.name} was interrupted. Check the connection and try again.`);
    }
    if (!res.ok) {
      const t = await res.text();
      let msg = t.trim().slice(0, 300);
      try {
        msg = String((JSON.parse(t) as { error?: unknown }).error ?? msg);
      } catch {
        /* plain-text proxy error */
      }
      throw new Error(`Uploading ${file.name} failed: ${msg || res.status}`);
    }
    sent = end;
  }
  onProgress(`Uploaded ${label}`);
  return `${id}|${file.name}`;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const duration = (s: number | null) => {
  if (s === null || !Number.isFinite(s)) return "";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m} min ${r} s` : `${r} s`;
};

export default function Filler() {
  const [xml, setXml] = useState<File[]>([]);
  const [template, setTemplate] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);

  useEffect(() => {
    if (!job || job.phase === "done" || job.phase === "error" || job.phase === "cancelled") return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/fill?job=${job.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { job: JobView };
        setJob(json.job);
      } catch {
        /* transient - keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [job]);

  async function run() {
    if (xml.length === 0 || template.length === 0) return;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const xmlRef = await upload(xml[0], xml[0].name, setProgress);
      const templateRef = await upload(template[0], template[0].name, setProgress);
      setProgress("Starting the dump job…");
      const fd = new FormData();
      fd.append("xmlRef", xmlRef);
      fd.append("templateRef", templateRef);
      const res = await fetch("/api/fill", { method: "POST", body: fd });
      const text = await res.text();
      let json: { job?: JobView; error?: string } = {};
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        /* proxy error */
      }
      if (!res.ok || !json.job) throw new Error(json.error ?? (text.trim().slice(0, 300) || "Could not start the dump job."));
      setJob(json.job);
      setProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  const active =
    job !== null && (job.phase === "queued" || job.phase === "prepare" || job.phase === "fill" || job.phase === "zip");
  const pct =
    job && job.totalBytes > 0 ? Math.min(100, Math.round((job.bytes / job.totalBytes) * 100)) : null;
  const phase =
    job?.phase === "queued"
      ? `Waiting in queue${job.queuePosition ? ` (position ${job.queuePosition})` : ""}`
      : job?.phase === "prepare"
        ? "Preparing the template…"
        : job?.phase === "fill"
          ? `Creating the dump${pct !== null ? ` — ${pct}%` : "…"}`
          : job?.phase === "zip"
            ? "Packaging the ZIP…"
            : job?.phase === "done"
              ? "Done"
              : job?.phase === "cancelled"
                ? "Cancelled"
                : null;

  return (
    <div className="space-y-5">
      <section className="surface animate-fade-up space-y-4 p-5 sm:p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <DropZone
            label="1. RAML XML export"
            hint="XML, XML.gz or a RAR containing it (the whole export)"
            accept=".xml,.rar,.gz"
            files={xml}
            onChange={setXml}
          />
          <DropZone
            label="2. NetAct dump template"
            hint="Dump 4G+5G.mdb / .accdb — rows are created in place"
            accept=".mdb,.accdb"
            files={template}
            onChange={setTemplate}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {xml.length > 0 && template.length > 0
              ? `${sizeLabel(xml[0].size)} + ${sizeLabel(template[0].size)}. The export is streamed; the created dump is returned as a ZIP.`
              : "Upload both files. Large exports are sent in chunks and the dump is created in the background."}
          </p>
          <button
            className="btn-primary"
            disabled={busy || active || xml.length === 0 || template.length === 0}
            onClick={run}
          >
            {busy ? "Uploading…" : active ? "Creating dump…" : "Create dump"}
          </button>
        </div>

        {progress && (
          <p className="animate-fade-up rounded-2xl border border-brand-500/30 bg-brand-500/10 px-4 py-3 text-sm text-brand-700 dark:text-brand-300">
            {progress}
          </p>
        )}
        {error && (
          <p className="animate-fade-up whitespace-pre-line rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}

        {job && (
          <div className="animate-fade-up space-y-3 rounded-2xl border border-slate-200 bg-white/70 px-4 py-4 dark:border-white/10 dark:bg-white/5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{phase}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {job.rows > 0 && `${fmt(job.rows)} rows · `}
                {job.objects > 0 && `${fmt(job.objects)} objects`}
                {job.elapsedSeconds > 0 && ` · ${duration(job.elapsedSeconds)}`}
              </p>
            </div>
            {job.phase === "fill" && (
              <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                <div
                  className={`h-full rounded-full bg-gradient-to-r from-brand-600 to-violet-500 transition-all ${pct === null ? "animate-pulse w-1/3" : ""}`}
                  style={pct === null ? undefined : { width: `${Math.max(2, pct)}%` }}
                />
              </div>
            )}
            {job.phase === "done" && job.result && (
              <div className="space-y-2 text-sm text-slate-700 dark:text-slate-300">
                <p>
                  Created {fmt(job.result.rows)} rows from {fmt(job.result.objects)} objects in{" "}
                  {duration(job.result.seconds)}. Dump size {job.result.sizeMB} MB.
                  {job.result.exportTime ? ` Export time ${job.result.exportTime}.` : ""}
                </p>
                <p className={job.result.errors > 0 ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}>
                  {job.result.errors === 0
                    ? "All rows were written without errors."
                    : `${fmt(job.result.errors)} values/rows were skipped (usually parameters that this template does not import).`}
                </p>
                {job.result.errorTables.length > 0 && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Most affected tables: {job.result.errorTables.slice(0, 5).map(([t, n]) => `${t} (${n})`).join(", ")}
                  </p>
                )}
                {job.downloadUrl && (
                  <a className="btn-primary mt-1 inline-flex" href={job.downloadUrl}>
                    Download {job.zipName ?? "the ZIP"}
                  </a>
                )}
              </div>
            )}
            {job.phase === "error" && (
              <p className="whitespace-pre-line text-sm text-red-700 dark:text-red-300">{job.error}</p>
            )}
          </div>
        )}

        <details className="rounded-2xl border border-slate-200 bg-white/50 px-4 py-3 text-xs text-slate-600 dark:border-white/10 dark:bg-white/[0.02] dark:text-slate-400">
          <summary className="cursor-pointer select-none font-medium">How it works</summary>
          <p className="mt-2 leading-relaxed">
            Every <code>managedObject</code> from the RAML export is matched to the template&apos;s{" "}
            <code>IMPORT_CLASS_FILTER</code> rules. Parameters go into <code>A_&lt;class&gt;</code> tables, nested
            lists become child rows (with <code>listId</code>) or flattened block rows, and the export timestamp is
            written to <code>last_modified</code> / <code>last_actual_import</code>. The job runs in the background on
            the server; you can leave this page and come back with the job id, but a server restart cancels it.
          </p>
        </details>
      </section>
    </div>
  );
}
