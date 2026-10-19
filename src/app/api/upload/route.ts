import { NextResponse } from "next/server";
import { releaseMemorySoon } from "@/lib/mem";
import { UPLOAD_CHUNK_MAX, appendChunk, isUploadId, sweepUploads } from "@/lib/uploads";

export const runtime = "nodejs";
export const maxDuration = 300;

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * Receives one chunk of a large database file (see src/lib/uploads.ts). Each request carries a
 * small body, so hosting proxies that cut off long uploads (Railway: 5 minutes per request body)
 * never see a long-running upload. The assembled file is picked up by /api/convert or
 * /api/inspect through `dbRef` fields and deleted right after.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const id = String(form.get("id") ?? "");
    if (!isUploadId(id)) return fail("Invalid upload id.");
    const chunk = form.get("chunk");
    if (!(chunk instanceof Blob) || chunk.size === 0) return fail("Empty chunk.");
    if (chunk.size > UPLOAD_CHUNK_MAX) return fail("Chunk is too large.");
    const total = await appendChunk(id, Buffer.from(await chunk.arrayBuffer()));
    return NextResponse.json({ ok: true, bytes: total });
  } catch (e) {
    console.error(e);
    return fail(e instanceof Error ? e.message : "Upload failed.", 500);
  } finally {
    releaseMemorySoon();
    void sweepUploads(); // drop chunks abandoned by earlier sessions
  }
}
