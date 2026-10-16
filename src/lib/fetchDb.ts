import dns from "node:dns/promises";
import net from "node:net";

/**
 * Downloads the database from a link the user pastes - a Google Drive share link or any direct http(s) link.
 * Runs on the server, so it is guarded: private/loopback addresses are blocked unless ALLOW_PRIVATE_URLS=true.
 *
 * env: MAX_DB_MB (default 1024)   ALLOW_PRIVATE_URLS (default false)
 */
const maxBytes = () => (Number(process.env.MAX_DB_MB) || 1024) * 1024 * 1024;
const allowPrivate = () => process.env.ALLOW_PRIVATE_URLS === "true";
const driveBase = () => process.env.DRIVE_DOWNLOAD_BASE ?? "https://drive.usercontent.google.com/download";

export type Fetched = { name: string; data: Buffer };

/** File id of a Google Drive link: /file/d/<id>/view, /open?id=<id>, /uc?id=<id>, drive.usercontent.google.com/download?id=<id> */
export function driveFileId(u: URL): string | null {
  if (u.hostname !== "drive.google.com" && u.hostname !== "drive.usercontent.google.com") return null;
  return u.pathname.match(/\/d\/([\w-]{10,})/)?.[1] ?? u.searchParams.get("id");
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return v.includes(".") ? isPrivateIp(v.slice(7)) : true;
  return v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

async function assertAllowed(u: URL) {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) links are supported.");
  if (allowPrivate()) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address)))
    throw new Error("Links to local / private network addresses are blocked (set ALLOW_PRIVATE_URLS=true to allow them).");
}

/** fetch() that follows redirects itself so every hop is checked. */
async function get(start: URL, signal: AbortSignal): Promise<{ res: Response; url: URL }> {
  let u = start;
  for (let hop = 0; hop < 6; hop++) {
    await assertAllowed(u);
    const res = await fetch(u, { redirect: "manual", signal, headers: { "user-agent": "Mozilla/5.0 (netact-xml-generator)" } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      u = new URL(loc, u);
      continue;
    }
    return { res, url: u };
  }
  throw new Error("Too many redirects.");
}

async function readBody(res: Response): Promise<Buffer> {
  const limit = maxBytes();
  const declared = Number(res.headers.get("content-length"));
  if (declared > limit) throw new Error(`The file is larger than the ${Math.round(limit / 1048576)} MB limit.`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`The file is larger than the ${Math.round(limit / 1048576)} MB limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Google shows a "can't scan this file for viruses" page for big files; its form re-submits with a confirm token. */
export function parseDriveForm(html: string, base: URL): URL | null {
  const f = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!f) return null;
  const action = new URL(unescapeHtml(f[1]), base);
  let found = false;
  for (const m of f[2].matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]*)"/)?.[1];
    const value = m[0].match(/value="([^"]*)"/)?.[1] ?? "";
    if (name) {
      action.searchParams.set(name, unescapeHtml(value));
      found = true;
    }
  }
  return found ? action : null;
}

function fileName(res: Response, url: URL, id: string | null): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  try {
    if (star) return decodeURIComponent(star.trim().replace(/^"|"$/g, ""));
  } catch {
    /* fall through */
  }
  if (plain) return plain.trim();
  const seg = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  return seg && !id ? seg : (id ?? "download");
}

export async function fetchDb(raw: string): Promise<Fetched> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("This is not a valid link.");
  }
  if (/\/folders\//.test(url.pathname)) throw new Error("Folder links are not supported - share the .rar / .zip / .xml file itself.");

  const id = driveFileId(url);
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  let next = id ? new URL(`${driveBase()}?id=${encodeURIComponent(id)}&export=download&confirm=t`) : url;

  for (let attempt = 0; attempt < 3; attempt++) {
    const { res, url: finalUrl } = await get(next, signal);
    if (!res.ok) {
      await res.body?.cancel();
      const hint = id && [403, 404].includes(res.status) ? " Check that the file is shared as “Anyone with the link”." : "";
      throw new Error(`The server answered ${res.status} ${res.statusText}.${hint}`);
    }
    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
      const html = await res.text();
      const form = id ? parseDriveForm(html, finalUrl) : null;
      if (form && attempt < 2) {
        next = form; // large-file confirmation page -> confirm and retry
        continue;
      }
      throw new Error(
        id
          ? "Google Drive returned a web page instead of the file. Set sharing to “Anyone with the link” (Viewer) and try again."
          : "The link returned a web page, not a file. Please use a direct download link.",
      );
    }
    return { name: fileName(res, finalUrl, id), data: await readBody(res) };
  }
  throw new Error("Could not get past the Google Drive confirmation page.");
}
