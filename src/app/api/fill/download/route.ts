import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { fillJobFile } from "@/lib/fillJobs";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Streams the finished ZIP (the .mdb is removed after zipping to keep the temp disk small). */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("job") ?? "";
  const file = fillJobFile(id, "zip");
  if (!file) return NextResponse.json({ error: "The result is not ready." }, { status: 404 });
  const st = await fsp.stat(file.path).catch(() => null);
  if (!st?.isFile()) return NextResponse.json({ error: "The result has expired." }, { status: 404 });

  const ascii = file.name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(file.name);
  const stream = Readable.toWeb(fs.createReadStream(file.path)) as unknown as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(st.size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "no-store",
    },
  });
}
