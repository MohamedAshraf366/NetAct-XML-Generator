import { NR_PARAMS, PARAMS } from "./config";

/**
 * Streaming RAML XML scanning for the database ingest pipeline. Pure functions only - no mdb /
 * archive imports - so a caller could run them off the main thread without pulling those in.
 */

export type DbObject = { cls: string; version: string; p: Record<string, string> };

export type DbLoad = {
  objects: Map<string, DbObject>;
  filesRead: number;
  scanned: number;
};

/** XML-unescape, but skip the five regex passes entirely when there is nothing to unescape. */
function decode(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * XML-decoded value of one attribute inside an element's attribute string.
 * Hand-rolled indexOf scan (no regex) - this runs once per managed object, so it matters.
 */
export function attrValue(s: string, name: string): string | undefined {
  const len = name.length;
  for (let idx = s.indexOf(name); idx !== -1; idx = s.indexOf(name, idx + 1)) {
    const before = idx === 0 ? 32 : s.charCodeAt(idx - 1);
    if (!isSpace(before)) continue;
    let j = idx + len;
    let c = s.charCodeAt(j);
    while (isSpace(c)) c = s.charCodeAt(++j);
    if (c !== 61) continue; // '='
    c = s.charCodeAt(++j);
    while (isSpace(c)) c = s.charCodeAt(++j);
    if (c !== 34 && c !== 39) continue; // " or '
    const end = s.indexOf(c === 34 ? '"' : "'", j + 1);
    if (end !== -1) return decode(s.slice(j + 1, end));
  }
  return undefined;
}

const rxEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Parse the `<p name="...">value</p>` children of a managed object we actually keep.
 *
 * When we know exactly which parameters the diff can read back (`paramRx`), a single compiled
 * alternation extracts just those in one pass over the object; real managed objects carry hundreds
 * of parameters of which we need a handful. `paramRx === null` keeps every parameter (used by the
 * offline regression harness).
 */
function scanParams(data: Buffer, start: number, end: number, obj: DbObject, paramRx: RegExp | null) {
  if (paramRx) {
    const body = data.toString("utf8", start, end);
    paramRx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = paramRx.exec(body)) !== null) {
      obj.p[m[1]] = decode(m[2]).trim();
    }
    return;
  }

  let i = start;
  while (i < end) {
    const p = data.indexOf("<p", i, "latin1");
    if (p === -1 || p >= end) break;
    if (!isSpace(data[p + 2])) {
      i = p + 2;
      continue;
    }
    const gt = data.indexOf(">", p + 3, "latin1");
    if (gt === -1 || gt >= end) break;
    if (data[gt - 1] === 47) {
      i = gt + 1; // self-closing <p .../>
      continue;
    }
    const name = attrValue(data.toString("utf8", p + 3, gt), "name");
    const close = data.indexOf("</p>", gt + 1, "latin1");
    if (close === -1 || close >= end) break;
    if (name) obj.p[name] = decode(data.toString("utf8", gt + 1, close)).trim();
    i = close + 4;
  }
}

export type XmlTagSink = {
  /**
   * One `<managedObject ...>` start tag: the raw bytes after `<managedObject` up to (but not
   * including) the closing `>`, with a trailing `/` of a self-closing tag already removed.
   * Return true to also receive this object's body via `onBody`.
   */
  onTag(tag: Buffer, selfClose: boolean): boolean;
  /** The body between the tag's `>` and `</managedObject>` - only for objects whose onTag returned true. */
  onBody(body: Buffer): void | Promise<void>;
};

const OPEN_TAG_B = Buffer.from("<managedObject", "latin1");
const CLOSE_TAG_B = Buffer.from("</managedObject>", "latin1");
const DIST_B = Buffer.from('distName="', "latin1");
const MAX_TAG_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

const toBuf = (c: Buffer | Uint8Array): Buffer =>
  Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);

/**
 * Streaming RAML parser: pulls chunk after chunk (a 3 GB export never has to fit in memory) and
 * walks the managed objects with a small state machine, handling tags that straddle chunk
 * boundaries. Only the bodies of objects whose `onTag` returned true are assembled.
 */
export async function parseXmlStream(src: AsyncIterable<Buffer | Uint8Array>, sink: XmlTagSink): Promise<void> {
  const it = src[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  let pos = 0; // parse position inside buf
  let tagStart = 0; // buf index of the "<" of the current tag
  let bodyStart = 0; // buf index of the first unassembled body byte
  let scanFrom = 0; // where the `</managedObject>` search resumes
  let phase = 0; // 0 find tag, 1 read tag, 2 skip body, 3 assemble body
  let chunks: Buffer[] = [];
  let chunkBytes = 0;

  const first = await it.next();
  if (!first.done && first.value && first.value.length > 0) buf = toBuf(first.value);

  // Keep [keepFrom, end) and append the next chunk. Returns false at end of stream.
  const refill = async (keepFrom: number): Promise<boolean> => {
    if (keepFrom >= buf.length) buf = Buffer.alloc(0);
    else if (keepFrom > 0) buf = buf.subarray(keepFrom);
    for (;;) {
      const n = await it.next();
      if (n.done) return false;
      if (!n.value || n.value.length === 0) continue;
      const c = toBuf(n.value);
      buf = buf.length === 0 ? c : Buffer.concat([buf, c], buf.length + c.length);
      return true;
    }
  };

  for (;;) {
    if (phase === 0) {
      const q = buf.indexOf(OPEN_TAG_B, pos);
      if (q === -1) {
        pos = Math.max(pos, buf.length - (OPEN_TAG_B.length - 1)); // keep a partial marker
        if (!(await refill(pos))) break;
        pos = 0;
        continue;
      }
      tagStart = q;
      pos = q + OPEN_TAG_B.length;
      phase = 1;
      continue;
    }

    if (phase === 1) {
      const gt = buf.indexOf(0x3e, pos); // '>'
      if (gt === -1) {
        if (buf.length - pos > MAX_TAG_BYTES) {
          // not a real tag - rescan for the next marker after it
          pos = tagStart + OPEN_TAG_B.length;
          phase = 0;
          continue;
        }
        if (!(await refill(tagStart))) break;
        pos -= tagStart;
        tagStart = 0;
        continue;
      }
      const selfClose = gt > pos && buf[gt - 1] === 0x2f; // '/'
      const tag = buf.subarray(pos, selfClose ? gt - 1 : gt);
      const wantBody = sink.onTag(tag, selfClose) && !selfClose;
      pos = gt + 1;
      if (selfClose) phase = 0;
      else if (wantBody) {
        chunks = [];
        chunkBytes = 0;
        bodyStart = pos;
        scanFrom = pos;
        phase = 3;
      } else phase = 2;
      continue;
    }

    if (phase === 2) {
      const q = buf.indexOf(OPEN_TAG_B, pos);
      if (q === -1) {
        pos = Math.max(pos, buf.length - (OPEN_TAG_B.length - 1));
        if (!(await refill(pos))) break;
        pos = 0;
        continue;
      }
      tagStart = q;
      pos = q + OPEN_TAG_B.length;
      phase = 1;
      continue;
    }

    // phase 3: assemble the body of a wanted object
    const q = buf.indexOf(CLOSE_TAG_B, scanFrom);
    if (q === -1) {
      const cut = Math.max(bodyStart, buf.length - (CLOSE_TAG_B.length - 1)); // keep a partial close tag
      if (cut > bodyStart) {
        chunks.push(toBuf(buf.subarray(bodyStart, cut)));
        chunkBytes += cut - bodyStart;
      }
      if (chunkBytes > MAX_BODY_BYTES) {
        // pathological body - give up on it, resync after what we already read
        chunks = [];
        chunkBytes = 0;
        pos = cut;
        phase = 2;
        continue;
      }
      if (!(await refill(cut))) {
        // truncated file: keep the partial body rather than losing the whole object
        if (buf.length > 0) {
          chunks.push(toBuf(buf));
          chunkBytes += buf.length;
        }
        if (chunks.length > 0) {
          const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, chunkBytes);
          const p = sink.onBody(body);
          if (p) await p;
        }
        break;
      }
      bodyStart = 0;
      scanFrom = 0;
      continue;
    }
    if (q > bodyStart) {
      chunks.push(buf.subarray(bodyStart, q));
      chunkBytes += q - bodyStart;
    }
    {
      const body = chunks.length === 0 ? EMPTY : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, chunkBytes);
      const p = sink.onBody(body);
      if (p) await p;
    }
    chunks = [];
    chunkBytes = 0;
    pos = q + CLOSE_TAG_B.length;
    phase = 0;
  }
}

/** Class of a managed object, derived from its distName (the wanted set already filters by class). */
export function clsForDn(dn: string): string {
  if (dn.endsWith("/LNCEL_FDD-0")) return "NOKLTE:LNCEL_FDD";
  if (dn.endsWith("/LNCEL_TDD-0")) return "NOKLTE:LNCEL_TDD";
  if (dn.includes("/LNREL-")) return "NOKLTE:LNREL";
  if (dn.includes("/NRCELL-")) return "com.nokia.srbts.nrbts:NRCELL";
  return "NOKLTE:LNCEL";
}

/**
 * XML sink that keeps only objects in `wanted` (a huge network export does not blow up memory).
 * Each accepted object costs one byte-hash of its distName; only hash hits are even decoded -
 * the handful of cells the CSV actually names. `distName="` never needs a decoded string.
 */
export function makeScanSink(wanted: Set<string>, wantedParams: Set<string> | null, into: DbLoad): XmlTagSink {
  const hashes = new Set<number>();
  for (const dn of wanted) {
    const b = Buffer.from(dn, "utf8");
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193);
    }
    hashes.add(h);
  }

  const paramRx: RegExp | null =
    wantedParams && wantedParams.size > 0
      ? new RegExp(`<p name="(${Array.from(wantedParams, rxEscape).join("|")})">([^<]*)</p>`, "g")
      : null;

  let current: DbObject | null = null;

  return {
    onTag(tag: Buffer, selfClose: boolean): boolean {
      into.scanned++;
      const di = tag.indexOf(DIST_B);
      if (di === -1) return false;
      const vs = di + DIST_B.length;
      const ve = tag.indexOf(0x22, vs); // '"'
      if (ve === -1) return false;

      let h = 0x811c9dc5;
      for (let i = vs; i < ve; i++) {
        h ^= tag[i];
        h = Math.imul(h, 0x01000193);
      }
      if (!hashes.has(h)) return false;

      const dn = tag.toString("utf8", vs, ve);
      if (!wanted.has(dn)) return false;

      const obj = into.objects.get(dn) ?? { cls: clsForDn(dn), version: "", p: {} };
      const version = attrValue(tag.toString("latin1"), "version");
      if (version) obj.version = version;
      into.objects.set(dn, obj);
      if (selfClose) return false;
      current = obj;
      return true;
    },
    onBody(body: Buffer): void {
      if (current) scanParams(body, 0, body.length, current, paramRx);
      current = null;
    },
  };
}

const OPEN_OBJ = "<managedObject";
const MARKER_KEEP = OPEN_OBJ.length - 1; // a `<managedObject` prefix can straddle the chunk boundary
const PARAM_KEEP = 64; // a `name="..."` token can straddle it too
const MAX_CARRY = 64 * 1024 + 16; // a managedObject tag unresolved beyond this is skipped

/** `name="(tac|angle|...)"` over all known parameters, longest name first - V8's regex scans a
 * latin1 view several times faster than Buffer.indexOf, and unlike it only visits real hits. */
let inspectParamRx: RegExp | null = null;

function paramRegex(): RegExp {
  if (inspectParamRx) return inspectParamRx;
  const names = [...Object.keys(PARAMS), ...Object.keys(NR_PARAMS)].sort((a, b) => b.length - a.length);
  return (inspectParamRx = new RegExp(`name="(${names.map(rxEscape).join("|")})"`, "g"));
}

/**
 * Inspect a RAML document from its byte stream - a multi-GB export is walked chunk by chunk and
 * never held in memory, and unlike the full scan nothing is assembled per object: it counts
 * `<managedObject` tags, reads each tag's class, and matches `name="..."` tokens with one
 * alternation regex. Chunks are viewed as latin1 (byte = char) so string search applies.
 * Tokens straddling a chunk boundary are carried over.
 */
export async function inspectXmlStream(
  source: AsyncIterable<Buffer | Uint8Array>,
): Promise<{ objectsScanned: number; classes: string[]; params: string[] }> {
  const classesFound = new Set<string>();
  const paramsFound = new Set<string>();
  const rx = paramRegex();
  let count = 0;

  /**
   * Scans one chunk view. Returns where the carried tail starts and the position up to which
   * objects were counted; anything after `carryFrom` is re-scanned with the next chunk (params
   * live in a Set, objects resume from `objDone` so nothing is counted twice).
   */
  const scan = (buf: string, objSkip: number): { carryFrom: number; objDone: number } => {
    let carryFrom = buf.length;
    let objDone = buf.length;

    let oi = objSkip;
    for (;;) {
      const at = buf.indexOf(OPEN_OBJ, oi);
      if (at === -1) break;
      const gt = buf.indexOf(">", at + OPEN_OBJ.length);
      if (gt === -1) {
        carryFrom = Math.min(carryFrom, at);
        objDone = at;
        break;
      }
      count++;
      const cls = attrValue(buf.slice(at + OPEN_OBJ.length, gt), "class");
      if (cls) classesFound.add(cls);
      oi = gt + 1;
    }

    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(buf)) !== null) paramsFound.add(m[1]);

    return { carryFrom, objDone };
  };

  let carry = "";
  let objSkip = 0;
  for await (const c0 of source) {
    const chunk = toBuf(c0);
    if (chunk.length === 0) continue;
    const buf = carry.length === 0 ? chunk.toString("latin1") : carry + chunk.toString("latin1");
    const { carryFrom, objDone } = scan(buf, objSkip);
    const from = Math.max(Math.min(carryFrom, buf.length - PARAM_KEEP), buf.length - MAX_CARRY, 0);
    carry = buf.slice(from);
    // when every object was counted only a partial marker prefix can still need a rescan
    objSkip = objDone === buf.length ? Math.max(0, buf.length - from - MARKER_KEEP) : Math.max(0, objDone - from);
  }

  return { objectsScanned: count, classes: [...classesFound], params: [...paramsFound] };
}
