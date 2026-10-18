/**
 * Validation against the local real archives (paths below; skips with a message when absent):
 *   tsx scripts/test-big.ts parity   - old in-memory scanner vs new streaming parser on a real prefix
 *   tsx scripts/test-big.ts inspect  - inspectXmlStream throughput + parity on a real prefix
 *   tsx scripts/test-big.ts xml      - full pipeline timing on 12-1-2026.rar (3.0 GB XML inside)
 *   tsx scripts/test-big.ts mdb      - full pipeline + value check on 18-10-2026.rar (1.25 GB mdb inside)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import MDBReader from "mdb-reader";
import { loadDb, parseXmlStream, type DbObject } from "../src/lib/db";

const UNRAR = "C:\\Program Files\\WinRAR\\UnRAR.exe";
const XML_RAR = "C:\\Users\\ELBOSTAN\\Downloads\\12-1-2026.rar";
const XML_MEMBER = "12-1-2026.xml";
const MDB_RAR = "C:\\Users\\ELBOSTAN\\Downloads\\18-10-2026.rar";
const MDB_MEMBER = "18-10-2026.mdb";

function streamMember(archive: string, member: string, limit = Infinity): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(UNRAR, ["p", "-inul", "-p-", archive, member], { windowsHide: true });
    const parts: Buffer[] = [];
    let total = 0;
    child.stdout.on("data", (c: Buffer) => {
      if (total >= limit) return;
      parts.push(c);
      total += c.length;
      if (total >= limit) child.kill();
    });
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(parts, total)));
  });
}

const rss = () => Math.round(process.memoryUsage().rss / 1048576);

function haveFile(file: string): boolean {
  if (fs.existsSync(file)) return true;
  console.log(`skipped: ${file} not found (edit the paths at the top of this script)`);
  return false;
}

// ---------------------------------------------------------------- old scanner (copied from git history)

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

function decode(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attrValue(s: string, name: string): string | undefined {
  const len = name.length;
  for (let idx = s.indexOf(name); idx !== -1; idx = s.indexOf(name, idx + 1)) {
    const before = idx === 0 ? 32 : s.charCodeAt(idx - 1);
    if (!isSpace(before)) continue;
    let j = idx + len;
    let c = s.charCodeAt(j);
    while (isSpace(c)) c = s.charCodeAt(++j);
    if (c !== 61) continue;
    c = s.charCodeAt(++j);
    while (isSpace(c)) c = s.charCodeAt(++j);
    if (c !== 34 && c !== 39) continue;
    const end = s.indexOf(c === 34 ? '"' : "'", j + 1);
    if (end !== -1) return decode(s.slice(j + 1, end));
  }
  return undefined;
}

function oldScanParams(data: Buffer, start: number, end: number, obj: DbObject) {
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
      i = gt + 1;
      continue;
    }
    const name = attrValue(data.toString("utf8", p + 3, gt), "name");
    const close = data.indexOf("</p>", gt + 1, "latin1");
    if (close === -1 || close >= end) break;
    if (name) obj.p[name] = decode(data.toString("utf8", gt + 1, close)).trim();
    i = close + 4;
  }
}

function oldScanXml(data: Buffer, wanted: Set<string>): { objects: Map<string, DbObject>; scanned: number } {
  const objects = new Map<string, DbObject>();
  let scanned = 0;
  const KEY = 'distName="';
  const klen = KEY.length;
  const len = data.length;
  let p = data.indexOf(KEY, 0);
  while (p !== -1) {
    const vs = p + klen;
    let ve = vs;
    while (ve < len && data[ve] !== 34) ve++;
    if (ve >= len) break;
    const next = data.indexOf(KEY, ve);
    scanned++;
    const dn = data.toString("utf8", vs, ve);
    if (wanted.has(dn)) {
      const open = data.lastIndexOf("<managedObject", p);
      const tagStart = open < 0 ? vs : open + 13;
      const gt = data.indexOf(">", ve);
      if (gt !== -1) {
        const selfClose = data[gt - 1] === 47;
        const tag = data.toString("latin1", tagStart, selfClose ? gt - 1 : gt);
        let cls = "NOKLTE:LNCEL";
        if (dn.endsWith("/LNCEL_FDD-0")) cls = "NOKLTE:LNCEL_FDD";
        else if (dn.endsWith("/LNCEL_TDD-0")) cls = "NOKLTE:LNCEL_TDD";
        else if (dn.includes("/LNREL-")) cls = "NOKLTE:LNREL";
        else if (dn.includes("/NRCELL-")) cls = "com.nokia.srbts.nrbts:NRCELL";
        const version = attrValue(tag, "version");
        const obj = objects.get(dn) ?? { cls, version: "", p: {} };
        if (version) obj.version = version;
        if (!selfClose) {
          const bodyStart = gt + 1;
          const bodyEnd = next === -1 ? len : data.lastIndexOf("<managedObject", next);
          if (bodyEnd > bodyStart) oldScanParams(data, bodyStart, bodyEnd, obj);
        }
        objects.set(dn, obj);
      }
    }
    p = next;
  }
  return { objects, scanned };
}

function deepEqualObjects(a: Map<string, DbObject>, b: Map<string, DbObject>): string | null {
  if (a.size !== b.size) return `size ${a.size} vs ${b.size}`;
  for (const [dn, oa] of a) {
    const ob = b.get(dn);
    if (!ob) return `missing ${dn}`;
    if (oa.cls !== ob.cls) return `${dn}: cls ${oa.cls} vs ${ob.cls}`;
    if (oa.version !== ob.version) return `${dn}: version "${oa.version}" vs "${ob.version}"`;
    const ka = Object.keys(oa.p);
    const kb = Object.keys(ob.p);
    if (ka.length !== kb.length) return `${dn}: param count ${ka.length} vs ${kb.length}`;
    for (const k of ka) {
      if (oa.p[k] !== ob.p[k]) return `${dn}: ${k} = "${oa.p[k]}" vs "${ob.p[k]}"`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- chunk stress

type Raw = { dn: string; tag: string; selfClose: boolean; body: string };

async function collectRaw(chunks: Buffer[]): Promise<{ objects: Raw[]; scanned: number }> {
  const objects: Raw[] = [];
  let current: Raw | null = null;
  await parseXmlStream(
    (async function* () {
      for (const c of chunks) yield c;
    })(),
    {
      onTag(tag, selfClose) {
        const t = tag.toString("latin1");
        const di = t.indexOf('distName="');
        const dn = di === -1 ? "" : t.slice(di + 10, t.indexOf('"', di + 10));
        current = { dn, tag: t, selfClose, body: "" };
        objects.push(current);
        return !selfClose;
      },
      onBody(body) {
        if (current) current.body = body.toString("utf8");
        current = null;
      },
    },
  );
  return { objects, scanned: objects.length };
}

function compareRaw(a: Raw[], b: Raw[], label: string): string | null {
  if (a.length !== b.length) return `${label}: object count ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i].dn !== b[i].dn) return `${label}: [${i}] dn ${a[i].dn} vs ${b[i].dn}`;
    if (a[i].tag !== b[i].tag) return `${label}: [${i}] tag differs: ${a[i].tag} vs ${b[i].tag}`;
    if (a[i].selfClose !== b[i].selfClose) return `${label}: [${i}] selfClose`;
    if (a[i].body !== b[i].body) return `${label}: [${i}] body differs (${a[i].body.length} vs ${b[i].body.length} bytes)`;
  }
  return null;
}

// ---------------------------------------------------------------- modes

const mode = process.argv[2] ?? "parity";

(async () => {
  if (mode === "parity") {
    if (!haveFile(XML_RAR)) return;
    const t0 = performance.now();
    const prefix = await streamMember(XML_RAR, XML_MEMBER, 48 * 1024 * 1024);
    console.log(`prefix: ${(prefix.length / 1048576).toFixed(0)} MB in ${(performance.now() - t0).toFixed(0)} ms, rss=${rss()} MB`);

    const wanted = new Set<string>();
    for (const m of prefix.toString("latin1").matchAll(/distName="([^"]+)"/g)) wanted.add(m[1]);
    console.log(`distNames in prefix: ${wanted.size}`);

    const t1 = performance.now();
    const oldRes = oldScanXml(prefix, wanted);
    console.log(`old scanner: ${oldRes.objects.size} objects, scanned=${oldRes.scanned}, ${(performance.now() - t1).toFixed(0)} ms, rss=${rss()} MB`);

    const t2 = performance.now();
    const loaded = await loadDb([{ name: "prefix.xml", data: prefix }], wanted, null);
    console.log(`new parser : ${loaded.objects.size} objects, scanned=${loaded.scanned}, ${(performance.now() - t2).toFixed(0)} ms, rss=${rss()} MB`);

    const diff = deepEqualObjects(oldRes.objects, loaded.objects);
    console.log(diff ? `MISMATCH: ${diff}` : `PARITY OK: objects identical (cls, version, every param)`);
    if (oldRes.scanned !== loaded.scanned) console.log(`WARN scanned count differs: ${oldRes.scanned} vs ${loaded.scanned}`);

    // chunk-boundary stress: same prefix, odd chunk sizes, raw sink comparison
    const t3 = performance.now();
    const one = await collectRaw([prefix]);
    console.log(`raw single chunk: ${one.objects.length} objects in ${(performance.now() - t3).toFixed(0)} ms`);

    for (const size of [3, 13, 1000, 8191, 64 * 1024]) {
      const t = performance.now();
      const chunks: Buffer[] = [];
      for (let o = 0; o < prefix.length; o += size) chunks.push(prefix.subarray(o, Math.min(o + size, prefix.length)));
      const res = await collectRaw(chunks);
      const d = compareRaw(one.objects, res.objects, `chunk=${size}`);
      console.log(d ? `MISMATCH ${d}` : `chunk=${size} OK (${res.objects.length} objects, ${(performance.now() - t).toFixed(0)} ms)`);
    }
    return;
  }

  if (mode === "inspect") {
    if (!haveFile(XML_RAR)) return;
    const { attrValue } = await import("../src/lib/db");
    const { inspectXmlStream } = await import("../src/lib/xmlscan");
    const { PARAMS, NR_PARAMS } = await import("../src/lib/config");

    const prefix = await streamMember(XML_RAR, XML_MEMBER, 96 * 1024 * 1024);
    const feed = (size: number) =>
      (async function* () {
        for (let o = 0; o < prefix.length; o += size) yield prefix.subarray(o, Math.min(o + size, prefix.length));
      })();

    // old implementation (parseXmlStream + per-object body scan), for parity
    const P_OPEN = Buffer.from("<p", "latin1");
    const NAME_EQ = Buffer.from('name="', "latin1");
    const tOld = performance.now();
    const oldClasses = new Set<string>();
    const oldParams = new Set<string>();
    let oldCount = 0;
    await parseXmlStream(feed(64 * 1024), {
      onTag(tag) {
        oldCount++;
        const cls = attrValue(tag.toString("latin1"), "class");
        if (cls) oldClasses.add(cls);
        return true;
      },
      onBody(body) {
        let i = 0;
        while ((i = body.indexOf(P_OPEN, i)) !== -1) {
          const c = body[i + 2];
          if (!(c === 0x20 || c === 0x09 || c === 0x3e || c === 0x2f)) {
            i += 2;
            continue;
          }
          const gt = body.indexOf(0x3e, i);
          if (gt === -1) break;
          const nq = body.indexOf(NAME_EQ, i);
          if (nq !== -1 && nq < gt) {
            const vs = nq + NAME_EQ.length;
            const ve = body.indexOf(0x22, vs);
            if (ve !== -1 && ve < gt) {
              const p = body.toString("utf8", vs, ve);
              if (p in PARAMS || p in NR_PARAMS) oldParams.add(p);
            }
          }
          i = gt + 1;
        }
      },
    });
    console.log(
      `old inspect: ${oldCount} objects, ${oldClasses.size} classes, ${oldParams.size} params in ${(performance.now() - tOld).toFixed(0)} ms`,
    );

    const t0 = performance.now();
    const res = await inspectXmlStream(feed(64 * 1024));
    const ms = performance.now() - t0;
    console.log(
      `new inspect: ${res.objectsScanned} objects, ${res.classes.length} classes, ${res.params.length} params in ${ms.toFixed(0)} ms ` +
        `(${(prefix.length / 1048576 / (ms / 1000)).toFixed(0)} MB/s, rss=${Math.round(process.memoryUsage().rss / 1048576)} MB)`,
    );

    const same =
      oldCount === res.objectsScanned &&
      oldClasses.size === res.classes.length &&
      [...oldClasses].every((c) => res.classes.includes(c)) &&
      oldParams.size === res.params.length &&
      [...oldParams].every((p) => res.params.includes(p));
    console.log(same ? "PARITY OK: inspect identical (objects, classes, params)" : "MISMATCH: inspect differs from old parser");
    if (!same) {
      console.log(`classes old: ${[...oldClasses].join(", ")}`);
      console.log(`classes new: ${res.classes.join(", ")}`);
      console.log(`params old : ${[...oldParams].join(", ")}`);
      console.log(`params new : ${res.params.join(", ")}`);
    }
    return;
  }

  if (mode === "xml") {
    if (!haveFile(XML_RAR)) return;
    const data = fs.readFileSync(XML_RAR);
    const head = await streamMember(XML_RAR, XML_MEMBER, 96 * 1024 * 1024);
    const all = [...head.toString("latin1").matchAll(/distName="([^"]+)"/g)].map((m) => m[1]);
    let wanted = new Set(all.filter((d) => /\/LNCEL-\d+$/.test(d)).slice(0, 4000));
    if (wanted.size === 0) wanted = new Set(all.filter((d) => d.includes("/LNCEL-")).slice(0, 4000));
    console.log(`distNames in 96MB head: ${all.length}; wanted cells: ${wanted.size}; sample: ${all[0]}`);
    if (wanted.size === 0) wanted.add("PLMN-PLMN/MRBTS-1/LNBTS-1/LNCEL-1");
    const params = new Set(["angle", "phyCellId", "tac", "pMax", "dlRsBoost"]);
    console.log(`rss before: ${rss()} MB; streaming ${XML_RAR} (path fast route)...`);
    const t0 = performance.now();
    const loaded = await loadDb([{ name: "12-1-2026.rar", data, path: XML_RAR }], wanted, params);
    console.log(
      `loadDb: ${(performance.now() - t0).toFixed(0)} ms total, scanned=${loaded.scanned} objects, matched=${loaded.objects.size}, rss=${rss()} MB`,
    );
    const tmpLeft = fs.readdirSync(process.env.TEMP ?? "C:\\Windows\\Temp").filter((f) => f.startsWith("netact-"));
    console.log(`leftover temp archives: ${tmpLeft.length}`);
    return;
  }

  if (mode === "mdb") {
    if (!haveFile(MDB_RAR)) return;
    // Build a realistic wanted set + expected values straight from the database itself
    const mdbBuf = await streamMember(MDB_RAR, MDB_MEMBER);
    console.log(`mdb extracted: ${(mdbBuf.length / 1048576).toFixed(0)} MB, rss=${rss()} MB`);
    const reader = new MDBReader(mdbBuf);
    const rows = reader
      .getTable("A_LTE_MRBTS_LNBTS_LNCEL")
      .getData({ columns: ["mrbtsId", "lnBtsId", "lnCelId", "angle", "phyCellId"] })
      .slice(0, 4000);
    const wanted = new Set<string>();
    const expected = new Map<string, { angle: string; phyCellId: string }>();
    for (const r of rows) {
      const dn = `PLMN-PLMN/MRBTS-${r.mrbtsId}/LNBTS-${r.lnBtsId}/LNCEL-${r.lnCelId}`;
      wanted.add(dn);
      expected.set(dn, { angle: String(r.angle ?? ""), phyCellId: String(r.phyCellId ?? "") });
    }
    console.log(`wanted cells: ${wanted.size}`);

    const data = fs.readFileSync(MDB_RAR);
    console.log(`rss before: ${rss()} MB; streaming ${MDB_RAR}...`);
    const t0 = performance.now();
    const loaded = await loadDb([{ name: "18-10-2026.rar", data, path: MDB_RAR }], wanted, new Set(["angle", "phyCellId"]));
    console.log(`loadDb: ${(performance.now() - t0).toFixed(0)} ms, scanned=${loaded.scanned}, matched=${loaded.objects.size}, rss=${rss()} MB`);
    let bad = 0;
    for (const [dn, exp] of expected) {
      const o = loaded.objects.get(dn);
      if (!o) continue; // row not wanted through a param check
      if (exp.angle !== "" && o.p.angle !== undefined && o.p.angle !== exp.angle) bad++;
      if (exp.phyCellId !== "" && o.p.phyCellId !== undefined && o.p.phyCellId !== exp.phyCellId) bad++;
    }
    console.log(`value mismatches vs mdb-reader: ${bad} (checked ${expected.size} cells)`);
    return;
  }

  console.log("unknown mode");
})();
