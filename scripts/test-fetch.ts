/** npm run test:fetch - checks the "paste a link" downloader against a local imitation server. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";
import { DEFAULT_PARAM_NAMES, PARAM_NAMES } from "../src/lib/config";
import { buildChanges, wantedDistNames } from "../src/lib/diff";
import { loadDb } from "../src/lib/db";
import { driveFileId, fetchDb } from "../src/lib/fetchDb";
import { canonicalize, readInput } from "../src/lib/input";
import { writeRaml } from "../src/lib/xml";

const samples = path.join(__dirname, "..", "samples");
const xmlDb = fs.readFileSync(path.join(samples, "2600.test-db.xml"));
const csv = fs.readFileSync(path.join(samples, "2600.csv"));
const expected = fs.readFileSync(path.join(samples, "2600.expected.xml"), "utf8");

/** tiny stored (uncompressed) RAR 4 archive holding one file */
function makeRar(name: string, data: Buffer): Buffer {
  const crc32 = (b: Buffer) => zlib.crc32(b) >>> 0;
  const blk = (type: number, flags: number, body: Buffer) => {
    const hdr = Buffer.concat([Buffer.from([type]), u16(flags), u16(7 + body.length), body]);
    return Buffer.concat([u16(crc32(hdr) & 0xffff), hdr]);
  };
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const nm = Buffer.from(name);
  const fileBody = Buffer.concat([u32(data.length), u32(data.length), Buffer.from([2]), u32(crc32(data)), u32(0x5a3f0000),
    Buffer.from([20, 0x30]), u16(nm.length), u32(0x20), nm]);
  return Buffer.concat([Buffer.from("Rar!\x1a\x07\x00", "latin1"), blk(0x73, 0, Buffer.alloc(6)), blk(0x74, 0x8000, fileBody), data,
    Buffer.from([0xc4, 0x3d, 0x7b, 0x00, 0x40, 0x07, 0x00])]);
}

let zipBuf: Buffer;
const rarBuf = makeRar("export.xml", xmlDb);
const hits: string[] = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  hits.push(u.pathname + u.search);
  const send = (code: number, body: Buffer | string, h: Record<string, string> = {}) => { res.writeHead(code, h); res.end(body); };
  switch (u.pathname) {
    case "/plain.xml": return send(200, xmlDb, { "content-type": "application/xml" });
    case "/go": return send(302, "", { location: "/blob" });
    case "/blob": return send(200, rarBuf, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="11-10-2026.rar"' });
    case "/drive/download": // big-file warning page first, real file once the form is confirmed
      if (u.searchParams.get("uuid") === "abc-123")
        return send(200, zipBuf, { "content-type": "application/zip", "content-disposition": "attachment; filename*=UTF-8''db%20big.zip" });
      if (u.searchParams.get("id") === "PRIVATEFILE0001") return send(200, "<html><title>Sign in</title><body>Sign in to continue</body></html>", { "content-type": "text/html" });
      return send(200, `<html><body><form id="download-form" action="${base}/drive/download" method="get">
        <input type="hidden" name="id" value="${u.searchParams.get("id")}"><input type="hidden" name="export" value="download">
        <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="abc-123"></form></body></html>`, { "content-type": "text/html; charset=utf-8" });
    case "/page": return send(200, "<html>hello</html>", { "content-type": "text/html" });
    case "/gone": return send(404, "nope");
    default: return send(404, "?");
  }
});

let base = "";
let pass = 0, fail = 0;
const ok = (c: boolean, label: string, extra = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  -> " + extra : ""}`); };
const rejects = async (p: Promise<unknown>, re: RegExp) => { try { await p; return "(no error)"; } catch (e) { const m = (e as Error).message; return re.test(m) ? "ok:" + m : m; } };

(async () => {
  zipBuf = await (async () => { const z = new JSZip(); z.file("nested/export.xml", xmlDb); return Buffer.from(await z.generateAsync({ type: "uint8array" })); })();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.DRIVE_DOWNLOAD_BASE = `${base}/drive/download`;

  // --- Drive link shapes
  const id = process.env.TEST_DRIVE_ID ?? "PLACEHOLDER_DRIVE_FILE_ID";
  for (const l of [`https://drive.google.com/file/d/${id}/view?usp=sharing`, `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/uc?export=download&id=${id}`, `https://drive.usercontent.google.com/download?id=${id}&export=download`])
    ok(driveFileId(new URL(l)) === id, "Drive id parsed", l.slice(0, 60));
  ok(driveFileId(new URL("https://example.com/file/d/1234567890abc")) === null, "non-Drive host ignored");

  // --- SSRF guard (private addresses blocked by default)
  delete process.env.ALLOW_PRIVATE_URLS;
  let r = await rejects(fetchDb(`${base}/plain.xml`), /blocked/);
  ok(r.startsWith("ok:"), "localhost link blocked by default", r);
  process.env.ALLOW_PRIVATE_URLS = "true";

  // --- download scenarios
  let f = await fetchDb(`${base}/plain.xml`);
  ok(f.name === "plain.xml" && f.data.equals(xmlDb), "direct .xml link", f.name);

  f = await fetchDb(`${base}/go`);
  ok(f.name === "11-10-2026.rar" && f.data.equals(rarBuf), "redirect + Content-Disposition file name", f.name);

  hits.length = 0;
  f = await fetchDb(`https://drive.google.com/file/d/${id}/view?usp=sharing`);
  ok(f.name === "db big.zip" && f.data.equals(zipBuf), "Drive large-file confirm page handled", `${f.name}, ${hits.length} requests`);

  r = await rejects(fetchDb("https://drive.google.com/file/d/PRIVATEFILE0001/view"), /Anyone with the link/);
  ok(r.startsWith("ok:"), "private Drive file -> clear message", r.slice(0, 90));
  r = await rejects(fetchDb("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn"), /Folder links/);
  ok(r.startsWith("ok:"), "folder link rejected", r.slice(0, 60));
  r = await rejects(fetchDb(`${base}/page`), /web page/);
  ok(r.startsWith("ok:"), "HTML page instead of file rejected", r.slice(0, 60));
  r = await rejects(fetchDb(`${base}/gone`), /404/);
  ok(r.startsWith("ok:"), "HTTP 404 reported", r.slice(0, 60));
  r = await rejects(fetchDb("not a link"), /valid link/);
  ok(r.startsWith("ok:"), "invalid link rejected", r);
  r = await rejects(fetchDb("ftp://example.com/x.xml"), /http/);
  ok(r.startsWith("ok:"), "non-http scheme rejected", r.slice(0, 60));
  process.env.MAX_DB_MB = "0.00005";
  r = await rejects(fetchDb(`${base}/plain.xml`), /larger than/);
  ok(r.startsWith("ok:"), "size limit enforced", r.slice(0, 60));
  delete process.env.MAX_DB_MB;

  // --- whole pipeline from a link: download -> read database -> diff -> XML == your 2600.xml
  for (const [label, url] of [["RAR with no extension in URL", `${base}/go`], ["Drive zip", `https://drive.google.com/file/d/${id}/view`]] as const) {
    const got = await fetchDb(url);
    const parsed = await readInput("2600.csv", csv);
    const { header, rows } = canonicalize(parsed.header, parsed.rows, ["mrbtsId", "lnBtsId", "lnCelId", "lnRelId", ...PARAM_NAMES]);
    const params = DEFAULT_PARAM_NAMES.filter((p) => header.includes(p));
    const db = await loadDb([got], wantedDistNames(rows, params));
    const out = writeRaml(buildChanges(rows, params, db.objects).changes, "2600");
    const strip = (s: string) => s.replace(/dateTime="[^"]+"/, "");
    ok(strip(out) === strip(expected), `pipeline from link: ${label} -> identical to your 2600.xml`);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
