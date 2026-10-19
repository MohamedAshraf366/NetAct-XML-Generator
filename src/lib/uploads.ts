import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Chunked database uploads. Hosting proxies (e.g. Railway's edge) close any request whose body
 * takes longer than ~5 minutes to arrive, and a slow uplink can exceed that even for a ~60 MB
 * archive. The UI therefore sends large database files in small chunks; each chunk is appended to
 * a temp file here, and the convert / inspect route reads that file back by id within the same
 * call and deletes it afterwards. Uploads abandoned mid-way are swept after a few hours.
 */
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

/** Chunks posted by the UI; larger pieces are rejected. */
export const UPLOAD_CHUNK_MAX = 16 * 1024 * 1024;

const maxBytes = () => (Number(process.env.MAX_UPLOAD_MB) || 4096) * 1024 * 1024;

export function isUploadId(id: string): boolean {
  return ID_RE.test(id);
}

const dir = () => path.join(process.env.NETACT_TMP_DIR || os.tmpdir(), "netact-uploads");

export function uploadPath(id: string): string {
  return path.join(dir(), `${id}.bin`);
}

/** Appends one chunk; returns the total size so far. Throws past the size cap. */
export async function appendChunk(id: string, chunk: Uint8Array): Promise<number> {
  await fsp.mkdir(dir(), { recursive: true });
  const p = uploadPath(id);
  const before = await fsp.stat(p).then((s) => s.size).catch(() => 0);
  if (before + chunk.byteLength > maxBytes()) {
    await fsp.unlink(p).catch(() => {});
    throw new Error(`The database file exceeds the ${Math.round(maxBytes() / 1048576)} MB limit.`);
  }
  await fsp.appendFile(p, chunk);
  return before + chunk.byteLength;
}

export async function removeUploads(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => fsp.unlink(uploadPath(id)).catch(() => {})));
}

/** Drops chunks from sessions that were abandoned (default: older than 6 hours). */
export async function sweepUploads(olderThanMs = 6 * 3600_000): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  const entries = await fsp.readdir(dir()).catch(() => [] as string[]);
  await Promise.all(
    entries.map(async (name) => {
      const p = path.join(dir(), name);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fsp.unlink(p).catch(() => {});
    }),
  );
}
