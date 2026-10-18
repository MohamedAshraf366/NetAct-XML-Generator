import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import JSZip from "jszip";
import { createExtractorFromData } from "node-unrar-js";

/**
 * Database ingestion pipeline: xml / mdb / gz / zip / rar, archives inside archives.
 *
 * Large dumps (multi-GB RAML XML or Access .mdb inside a .rar) are never unpacked into memory.
 * A RAR without a native unrar keeps growing until it OOMs, so when a native UnRAR / Rar
 * executable is found the members are streamed from its stdout straight into the sink (the
 * scanner consumes them chunk by chunk, constant memory, native decompression speed).
 * gz is streamed through zlib, zip entries through the JSZip node stream.
 *
 * env: UNRAR_PATH (force an executable)   NO_NATIVE_UNRAR=1 (force the in-memory fallback)
 *      NETACT_TMP_DIR (where a temporary copy of an uploaded .rar is placed)   MAX_EXTRACT_MB (default 3072)
 */

export type Kind = "xml" | "gz" | "zip" | "rar" | "mdb" | null;

export type DbSinks = {
  /** Receives the XML as a chunk stream (in-memory buffer or a piped archive member). */
  xml: (source: AsyncIterable<Buffer | Uint8Array>, name: string, bytes: number) => void | Promise<void>;
  /** Receives a complete .mdb / .accdb - mdb-reader needs random access to the whole file. */
  mdb: (data: Buffer, name: string) => void | Promise<void>;
};

const RAR_MEMBER_RX = /\.(xml|zip|gz|rar|mdb|accdb)$/i;
const MAX_EXTRACT = (Number(process.env.MAX_EXTRACT_MB) || 3072) * 1024 * 1024;
const WASM_RAR_LIMIT = (Number(process.env.MAX_WASM_RAR_MB) || 1500) * 1024 * 1024;

const toBuf = (c: Buffer | Uint8Array): Buffer =>
  Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);

async function* once(buf: Buffer): AsyncGenerator<Buffer> {
  yield buf;
}

/** Node Readable and legacy (readable-stream v2, what JSZip returns) streams alike. */
const streamToAsync = (s: unknown): AsyncIterable<Buffer> => {
  const anyS = s as { [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> } & NodeJS.ReadableStream;
  if (typeof anyS[Symbol.asyncIterator] === "function") return anyS as unknown as AsyncIterable<Buffer>;
  const pass = new PassThrough();
  anyS.on("error", (e) => pass.destroy(e as Error));
  anyS.pipe(pass);
  return pass;
};

const gunzipSource = (src: AsyncIterable<Buffer | Uint8Array>): Readable => {
  const gzip = createGunzip();
  const rs = Readable.from(src, { objectMode: false });
  rs.on("error", (e) => gzip.destroy(e));
  rs.pipe(gzip);
  return gzip;
};

const tempDir = () => process.env.NETACT_TMP_DIR || os.tmpdir();

/** Collects a stream into one Buffer. When the size is known ahead (RAR header) it is pre-allocated once. */
export async function collectStream(
  src: AsyncIterable<Buffer | Uint8Array>,
  expected = 0,
  limit = MAX_EXTRACT,
): Promise<Buffer> {
  const tooBig = () => new Error(`The unpacked file is larger than the ${Math.round(limit / 1048576)} MB extraction limit.`);
  if (expected > limit) throw tooBig();

  if (expected > 0) {
    const out = Buffer.allocUnsafe(expected);
    let off = 0;
    const spill: Buffer[] = [];
    let spillLen = 0;
    for await (const c0 of src) {
      const c = toBuf(c0);
      const take = Math.min(c.length, expected - off);
      if (take > 0) {
        c.copy(out, 0 + off, 0, take);
        off += take;
      }
      if (take < c.length) {
        spill.push(c.subarray(take));
        spillLen += c.length - take;
        if (spillLen > limit) throw tooBig();
      }
    }
    if (off === expected && spillLen === 0) return out;
    const tail = spill.length === 0 ? Buffer.alloc(0) : spill.length === 1 ? spill[0] : Buffer.concat(spill, spillLen);
    return tail.length === 0 ? out : Buffer.concat([out, tail], off + tail.length);
  }

  const parts: Buffer[] = [];
  let total = 0;
  for await (const c0 of src) {
    const c = toBuf(c0);
    total += c.length;
    if (total > limit) throw tooBig();
    parts.push(c);
  }
  if (parts.length === 0) return Buffer.alloc(0);
  if (parts.length === 1) return parts[0];
  return Buffer.concat(parts, total);
}

let cachedUnrar: string | null | undefined;

/** A native UnRAR/Rar executable, if this machine has one (cached). */
export function nativeUnrar(): string | null {
  if (cachedUnrar !== undefined) return cachedUnrar;
  if (process.env.NO_NATIVE_UNRAR === "1") return (cachedUnrar = null);
  const candidates = [
    process.env.UNRAR_PATH,
    "unrar",
    "C:\\Program Files\\WinRAR\\UnRAR.exe",
    "C:\\Program Files (x86)\\WinRAR\\UnRAR.exe",
    "C:\\Program Files\\WinRAR\\Rar.exe",
    "C:\\Program Files (x86)\\WinRAR\\Rar.exe",
    "/usr/bin/unrar",
    "/usr/local/bin/unrar",
    "/opt/homebrew/bin/unrar",
  ].filter((c): c is string => !!c);
  cachedUnrar = null;
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ["-?"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
      if (!r.error) {
        cachedUnrar = cmd;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return cachedUnrar;
}

type RarMember = { name: string; dir: boolean; size: number };

async function listRarMembers(data: Buffer): Promise<RarMember[]> {
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  try {
    const extractor = await createExtractorFromData({ data: ab });
    const out: RarMember[] = [];
    for (const h of extractor.getFileList().fileHeaders) {
      out.push({ name: h.name, dir: h.flags.directory, size: h.unpSize });
    }
    return out;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not read the RAR file (${why}). It may be corrupt, password-protected or one part of a multi-volume RAR - ` +
        `try extracting it and uploading the .mdb or .xml files or a .zip instead.`,
    );
  }
}

type MemberStream = { stream: Readable; done: Promise<void>; kill: () => void };

/** `UnRAR p -inul <archive> <member>`: the member file is written to stdout in a single pass. */
function spawnUnrarMember(unrar: string, archive: string, member: string, expected: number): MemberStream {
  const child: ChildProcess = spawn(unrar, ["p", "-inul", "-p-", archive, member], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let received = 0;
  child.stdout!.on("data", (c: Buffer) => (received += c.length));
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => {
    if (stderr.length < 2048) stderr += c.toString("latin1");
  });

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (e) =>
      reject(new Error(`Could not run "${unrar}" (${e.message}). Set UNRAR_PATH to a working UnRAR executable.`)),
    );
    child.on("close", (code) => {
      if (code === 0 && (expected === 0 || received === expected)) {
        resolve();
        return;
      }
      const why = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ") || `unrar exit code ${code}`;
      reject(
        new Error(
          `Could not extract "${member}" from "${path.basename(archive)}" (${why}). ` +
            `The archive may be corrupt, password-protected or part of a multi-volume set.`,
        ),
      );
    });
  });

  return {
    stream: child.stdout!,
    done,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

async function ingestRar(
  name: string,
  data: Buffer,
  sinks: DbSinks,
  depth: number,
  filePath?: string,
): Promise<void> {
  const members = (await listRarMembers(data)).filter((m) => !m.dir && RAR_MEMBER_RX.test(m.name));
  if (members.length === 0) return;

  const unrar = nativeUnrar();
  if (unrar) {
    let archive = filePath && fs.existsSync(filePath) ? filePath : null;
    let temp: string | null = null;
    if (!archive) {
      temp = path.join(tempDir(), `netact-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.rar`);
      await fs.promises.writeFile(temp, data);
      archive = temp;
    }
    try {
      for (const m of members) {
        const member = spawnUnrarMember(unrar, archive, m.name, m.size);
        try {
          await ingestStream(m.name, member.stream, sinks, depth + 1, m.size);
          await member.done;
        } finally {
          member.kill();
          member.done.catch(() => {});
        }
      }
    } finally {
      if (temp) await fs.promises.unlink(temp).catch(() => {});
    }
    return;
  }

  // No native tool on this machine: fall back to the in-memory WASM extractor, which needs the
  // whole unpacked member (and a copy of the archive) in RAM.
  const biggest = members.reduce((a, m) => (m.size > a ? m.size : a), 0);
  if (biggest > WASM_RAR_LIMIT) {
    throw new Error(
      `"${name}" holds a ${(biggest / 1073741824).toFixed(1)} GB file, too large to unpack in memory. ` +
        `Install WinRAR / UnRAR or 7-Zip (or point UNRAR_PATH at unrar) so it can be streamed instead, ` +
        `or extract the file and upload it directly.`,
    );
  }
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  try {
    const extractor = await createExtractorFromData({ data: ab });
    const { files } = extractor.extract({ files: (h) => !h.flags.directory && RAR_MEMBER_RX.test(h.name) });
    for (const f of files) {
      if (f.fileHeader.flags.directory || !f.extraction) continue;
      await ingest(f.fileHeader.name, Buffer.from(f.extraction), sinks, depth + 1);
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not read "${name}" (${why}). It may be corrupt, password-protected or one part of a multi-volume RAR - ` +
        `try extracting it and uploading the .mdb or .xml files or a .zip instead.`,
    );
  }
}

async function ingestZip(name: string, data: Buffer, sinks: DbSinks, depth: number): Promise<void> {
  const zip = await JSZip.loadAsync(data);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    try {
      const stream =
        typeof entry.nodeStream === "function"
          ? streamToAsync(entry.nodeStream())
          : streamToAsync(Readable.from([await entry.async("nodebuffer")], { objectMode: false }));
      await ingestStream(entry.name, stream, sinks, depth + 1);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not read "${entry.name}" from "${name}" (${why}).`);
    }
  }
}

/** Ingest one archive member / decompressed stream. The first bytes decide the format. */
export async function ingestStream(
  name: string,
  src: AsyncIterable<Buffer | Uint8Array>,
  sinks: DbSinks,
  depth: number,
  expected = 0,
): Promise<void> {
  if (depth > 4) return;
  const it = src[Symbol.asyncIterator]();
  const head: Buffer[] = [];
  let headLen = 0;
  while (headLen < 64) {
    const n = await it.next();
    if (n.done) break;
    if (!n.value || n.value.length === 0) continue;
    const c = toBuf(n.value);
    head.push(c);
    headLen += c.length;
  }
  if (head.length === 0) return;

  const replay = (async function* (): AsyncGenerator<Buffer> {
    for (const h of head) yield h;
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      if (!n.value || n.value.length === 0) continue;
      yield toBuf(n.value);
    }
  })();

  const headBuf = head.length === 1 ? head[0] : Buffer.concat(head, headLen);
  switch (kindOf(name, headBuf)) {
    case "xml":
      await sinks.xml(replay, name, expected || headLen);
      return;
    case "mdb":
      await sinks.mdb(await collectStream(replay, expected), name);
      return;
    case "gz":
      await ingestStream(name.replace(/\.gz$/i, ""), gunzipSource(replay), sinks, depth + 1);
      return;
    case "zip":
    case "rar": {
      const buf = await collectStream(replay, expected, Math.min(MAX_EXTRACT, 2048 * 1024 * 1024));
      await ingest(name, buf, sinks, depth + 1);
      return;
    }
    default:
      return; // readme, csv, ... - nothing usable
  }
}

/** Magic bytes first (links often have no usable file name), extension as a fallback. */
export function kindOf(name: string, d: Buffer | Uint8Array): Kind {
  if (d.length > 6 && d.subarray(0, 4).toString("latin1") === "Rar!") return "rar";
  if (d.length > 3 && d[0] === 0x50 && d[1] === 0x4b && (d[2] === 3 || d[2] === 5)) return "zip";
  if (d.length > 2 && d[0] === 0x1f && d[1] === 0x8b) return "gz";
  if (
    d.length > 20 &&
    (d.subarray(4, 19).toString("latin1") === "Standard Jet DB" ||
      d.subarray(4, 19).toString("latin1") === "Standard ACE DB")
  ) {
    return "mdb";
  }
  const head = d.subarray(0, 64).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<")) return "xml";
  const l = name.toLowerCase();
  if (l.endsWith(".xml")) return "xml";
  if (l.endsWith(".gz")) return "gz";
  if (l.endsWith(".zip")) return "zip";
  if (l.endsWith(".rar")) return "rar";
  if (l.endsWith(".mdb") || l.endsWith(".accdb")) return "mdb";
  return null;
}

/**
 * Handles xml, mdb, gz, zip and rar - including archives nested inside archives.
 * `filePath`, when given, is the on-disk location the buffer was read from (local links);
 * a RAR can then be decompressed in place instead of via a temporary copy.
 */
export async function ingest(
  name: string,
  data: Buffer,
  sinks: DbSinks,
  depth = 0,
  filePath?: string,
): Promise<void> {
  if (depth > 4) return;
  const kind = kindOf(name, data);

  if (kind === "xml") {
    await sinks.xml(once(data), name, data.length);
  } else if (kind === "mdb") {
    await sinks.mdb(data, name);
  } else if (kind === "gz") {
    await ingestStream(name.replace(/\.gz$/i, ""), gunzipSource(once(data)), sinks, depth + 1);
  } else if (kind === "zip") {
    await ingestZip(name, data, sinks, depth);
  } else if (kind === "rar") {
    await ingestRar(name, data, sinks, depth, filePath);
  }
  // anything else (readme, csv, ...) is ignored
}
