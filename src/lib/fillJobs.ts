import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { ingest, kindOf } from "./archive";
import { buildFillSchema, fillDatabase, type FillResult } from "./fill";
import { releaseMemorySoon } from "./mem";
import { removeUploads } from "./uploads";

/**
 * Background RAML -> MDB fill jobs.
 *
 * The import of a multi-GB export takes tens of minutes, far longer than a request may live, so
 * POST /api/fill only enqueues the work. One worker runs at a time (each fill needs a Java writer
 * plus the Node parser) and the files are kept for a while so the browser can download the ZIP.
 *
 * Jobs live in this Node process: that is fine on Railway (one long-running container), but a
 * redeploy or restart drops queued/finished jobs (the temp files are swept later).
 */

export type FillPhase = "queued" | "prepare" | "fill" | "zip" | "done" | "error" | "cancelled";

type JobResult = {
  objects: number;
  parentRows: number;
  childRows: number;
  rows: number;
  errors: number;
  sizeMB: number;
  seconds: number;
  exportTime: string | null;
  errorSamples: string[];
  errorTables: [string, number][];
  skippedClass: [string, number][];
  unknownParams: [string, number][];
  unknownLists: [string, number][];
};

type Job = {
  id: string;
  phase: FillPhase;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  xmlName: string;
  templateName: string;
  xmlPath: string;
  templatePath: string;
  xmlUploadId: string | null;
  templateUploadId: string | null;
  dir: string;
  zipPath: string | null;
  zipName: string | null;
  mdbPath: string | null;
  bytes: number;
  totalBytes: number;
  objects: number;
  rows: number;
  result: JobResult | null;
  error: string | null;
};

type Store = { jobs: Map<string, Job>; queue: string[]; running: string | null };

const store: Store = ((globalThis as { __fillJobs?: Store }).__fillJobs ??= {
  jobs: new Map<string, Job>(),
  queue: [] as string[],
  running: null,
});

const baseDir = () => path.join(process.env.NETACT_TMP_DIR || os.tmpdir(), "netact-fill");
const top = (m: Map<string, number>, n = 15): [string, number][] => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const cleanName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "netact";

function baseName(name: string): string {
  return cleanName(
    name
      .replace(/\.(xml|mdb|accdb)(\.(gz|zip|rar))?$/i, "")
      .replace(/\.(gz|zip|rar)$/i, "")
      .trim(),
  );
}

export type FillJobView = {
  id: string;
  phase: FillPhase;
  queuePosition: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  xmlName: string;
  templateName: string;
  bytes: number;
  totalBytes: number;
  objects: number;
  rows: number;
  elapsedSeconds: number;
  etaSeconds: number | null;
  result: JobResult | null;
  error: string | null;
  downloadUrl: string | null;
  zipName: string | null;
};

export function fillJobView(job: Job): FillJobView {
  const now = job.finishedAt ?? Date.now();
  const elapsed = job.startedAt ? (now - job.startedAt) / 1000 : 0;
  const eta =
    job.phase === "fill" && job.startedAt && job.bytes > 0 && job.totalBytes > job.bytes && elapsed > 5
      ? Math.max(0, Math.round((elapsed / (job.bytes / job.totalBytes)) * (1 - job.bytes / job.totalBytes)))
      : null;
  const q = store.queue.indexOf(job.id);
  return {
    id: job.id,
    phase: job.phase,
    queuePosition: job.phase === "queued" && q >= 0 ? q + 1 : null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    xmlName: job.xmlName,
    templateName: job.templateName,
    bytes: job.bytes,
    totalBytes: job.totalBytes,
    objects: job.objects,
    rows: job.rows,
    elapsedSeconds: Math.round(elapsed),
    etaSeconds: eta,
    result: job.result,
    error: job.error,
    downloadUrl: job.phase === "done" ? `/api/fill/download?job=${job.id}` : null,
    zipName: job.zipName,
  };
}

export function getFillJob(id: string): FillJobView | null {
  const job = store.jobs.get(id);
  return job ? fillJobView(job) : null;
}

export function fillJobFile(id: string, kind: "mdb" | "zip"): { path: string; name: string } | null {
  const job = store.jobs.get(id);
  if (!job || job.phase !== "done") return null;
  const p = kind === "zip" ? job.zipPath : job.mdbPath;
  if (!p) return null;
  return { path: p, name: kind === "zip" ? (job.zipName ?? "netact.zip") : (job.zipName ?? "netact.zip").replace(/\.zip$/i, ".mdb") };
}

export type CreateFillJobInput = {
  xmlPath: string;
  xmlName: string;
  templatePath: string;
  templateName: string;
  xmlUploadId?: string | null;
  templateUploadId?: string | null;
};

export function createFillJob(input: CreateFillJobInput): FillJobView {
  const id = randomBytes(12).toString("hex");
  const dir = path.join(baseDir(), id);
  const job: Job = {
    id,
    phase: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    xmlName: input.xmlName,
    templateName: input.templateName,
    xmlPath: input.xmlPath,
    templatePath: input.templatePath,
    xmlUploadId: input.xmlUploadId ?? null,
    templateUploadId: input.templateUploadId ?? null,
    dir,
    zipPath: null,
    zipName: null,
    mdbPath: null,
    bytes: 0,
    totalBytes: 0,
    objects: 0,
    rows: 0,
    result: null,
    error: null,
  };
  store.jobs.set(id, job);
  store.queue.push(id);
  void sweepFillJobs();
  pump();
  return fillJobView(job);
}

export function cancelFillJob(id: string): boolean {
  const job = store.jobs.get(id);
  if (!job || job.phase !== "queued") return false;
  const i = store.queue.indexOf(id);
  if (i >= 0) store.queue.splice(i, 1);
  job.phase = "cancelled";
  job.finishedAt = Date.now();
  void cleanupJob(job, true);
  return true;
}

/** Deletes finished job directories older than `olderThanMs` (default 12 h). */
export async function sweepFillJobs(olderThanMs = 12 * 3600_000): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  const entries = await fsp.readdir(baseDir()).catch(() => [] as string[]);
  await Promise.all(
    entries.map(async (name) => {
      const job = store.jobs.get(name);
      if (job && job.phase !== "done" && job.phase !== "error" && job.phase !== "cancelled") return;
      const dir = path.join(baseDir(), name);
      const st = await fsp.stat(dir).catch(() => null);
      if (!st || st.mtimeMs >= cutoff) return;
      store.jobs.delete(name);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }),
  );
}

function pump(): void {
  if (store.running) return;
  const id = store.queue.shift();
  if (!id) return;
  const job = store.jobs.get(id);
  if (!job || job.phase !== "queued") {
    pump();
    return;
  }
  store.running = id;
  void run(job)
    .catch((e) => {
      job.phase = "error";
      job.error = e instanceof Error ? e.message : String(e);
      job.finishedAt = Date.now();
      console.error("fill job failed", job.id, e);
      void cleanupJob(job, true);
    })
    .finally(() => {
      store.running = null;
      releaseMemorySoon();
      pump();
    });
}

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

async function run(job: Job): Promise<void> {
  job.phase = "prepare";
  job.startedAt = Date.now();
  await fsp.mkdir(job.dir, { recursive: true });

  const mdbPath = path.join(job.dir, "out.mdb");
  job.mdbPath = mdbPath;

  // Validate the template before spending time on the upload.
  const templateHead = await readPrefix(job.templatePath, 64);
  if (kindOf(job.templateName, templateHead) !== "mdb") throw new Error("The template is not an Access .mdb/.accdb dump.");
  await fsp.copyFile(job.templatePath, mdbPath);
  if (job.templateUploadId) await removeUploads([job.templateUploadId]);

  const xmlHead = await readPrefix(job.xmlPath, 64);
  const kind = kindOf(job.xmlName, xmlHead);
  if (kind !== "xml" && kind !== "rar" && kind !== "gz") {
    throw new Error(
      kind === "zip"
        ? "ZIP archives are not supported here: upload the XML itself, an XML.gz, or a RAR."
        : "The export is not a RAML XML (or a RAR/GZ containing one).",
    );
  }
  const xmlSize = await fsp.stat(job.xmlPath).then((s) => s.size).catch(() => 0);

  job.totalBytes = kind === "xml" ? xmlSize : 0;
  job.phase = "fill";

  const schema = buildFillSchema(mdbPath);

  const counted = async function* (source: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<Buffer> {
    for await (const c of source) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);
      job.bytes += b.length;
      yield b;
    }
  };

  const acc: { result?: FillResult } = {};

  await ingest(
    job.xmlName,
    xmlHead,
    {
      xml: async (source, _name, expected) => {
        if (expected > 0) job.totalBytes = expected;
        acc.result = await fillDatabase(
          {
            templatePath: mdbPath,
            outPath: mdbPath,
            xml: counted(source),
            onProgress: (p) => {
              job.objects = p.objects;
              job.rows = p.rows;
            },
          },
          schema,
        );
      },
      mdb: async () => {
        throw new Error("The archive contains an Access database, not a RAML XML.");
      },
    },
    0,
    job.xmlPath,
  );

  const fillResult = acc.result;
  if (!fillResult) throw new Error("No RAML XML was found in the upload.");

  job.objects = fillResult.objects;
  job.rows = fillResult.parentRows + fillResult.childRows;
  job.result = {
    objects: fillResult.objects,
    parentRows: fillResult.parentRows,
    childRows: fillResult.childRows,
    rows: job.rows,
    errors: fillResult.errors,
    sizeMB: Math.round((await fsp.stat(mdbPath)).size / 1048576),
    seconds: Math.round((Date.now() - (job.startedAt ?? Date.now())) / 1000),
    exportTime: fillResult.exportTime,
    errorSamples: fillResult.errorSamples,
    errorTables: fillResult.errorTables,
    skippedClass: top(fillResult.skippedClass),
    unknownParams: top(fillResult.unknownParams),
    unknownLists: top(fillResult.unknownLists),
  };

  // The XML/template uploads are no longer needed - free their disk before creating the ZIP.
  if (job.xmlUploadId) await removeUploads([job.xmlUploadId]);
  job.phase = "zip";
  const base = baseName(job.xmlName);
  const zipPath = path.join(job.dir, `${base}.zip`);
  const zip = new yazl.ZipFile();
  zip.addFile(mdbPath, `${base}.mdb`, { compress: false });
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(zipPath));
  job.zipPath = zipPath;
  job.zipName = `${base}.zip`;
  await fsp.unlink(mdbPath).catch(() => {});
  job.mdbPath = null;
  job.phase = "done";
  job.finishedAt = Date.now();
  job.bytes = job.totalBytes || job.bytes;
}

async function cleanupJob(job: Job, removeInputs: boolean): Promise<void> {
  await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  if (removeInputs) {
    const ids = [job.xmlUploadId, job.templateUploadId].filter((x): x is string => Boolean(x));
    if (ids.length) await removeUploads(ids);
  }
}
