import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { kindOf } from "@/lib/archive";
import { cancelFillJob, createFillJob, getFillJob } from "@/lib/fillJobs";
import { isUploadId, uploadPath } from "@/lib/uploads";

export const runtime = "nodejs";
export const maxDuration = 300;

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

function refOf(value: FormDataEntryValue | null): { id: string; name: string } | null {
  const ref = String(value ?? "");
  const sep = ref.indexOf("|");
  if (sep === -1) return null;
  const id = ref.slice(0, sep);
  const name = ref.slice(sep + 1) || "upload.bin";
  return isUploadId(id) ? { id, name } : null;
}

async function readPrefix(filePath: string, n: number): Promise<Buffer> {
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Enqueues a fill job; the work itself runs in the Node process after this response. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const xmlRef = refOf(form.get("xmlRef"));
    const templateRef = refOf(form.get("templateRef"));
    if (!xmlRef) return fail("Choose the RAML XML export first.");
    if (!templateRef) return fail("Choose the empty NetAct dump template (.mdb).");

    const xmlPath = uploadPath(xmlRef.id);
    const templatePath = uploadPath(templateRef.id);
    const [xmlStat, templateStat] = await Promise.all([
      fs.stat(xmlPath).catch(() => null),
      fs.stat(templatePath).catch(() => null),
    ]);
    if (!xmlStat?.isFile() || xmlStat.size === 0) return fail("The XML upload was not found. Please upload it again.");
    if (!templateStat?.isFile() || templateStat.size === 0) return fail("The template upload was not found. Please upload it again.");

    const [xmlHead, templateHead] = await Promise.all([readPrefix(xmlPath, 64), readPrefix(templatePath, 64)]);
    const xmlKind = kindOf(xmlRef.name, xmlHead);
    if (xmlKind !== "xml" && xmlKind !== "rar" && xmlKind !== "gz") {
      return fail(
        xmlKind === "zip"
          ? "ZIP archives are not supported: upload the XML itself, an XML.gz, or a RAR."
          : "The export does not look like a RAML XML (or a RAR/GZ containing one).",
      );
    }
    if (kindOf(templateRef.name, templateHead) !== "mdb") {
      return fail("The template does not look like an Access .mdb/.accdb database.");
    }

    const job = createFillJob({
      xmlPath,
      xmlName: xmlRef.name,
      templatePath,
      templateName: templateRef.name,
      xmlUploadId: xmlRef.id,
      templateUploadId: templateRef.id,
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (e) {
    console.error(e);
    return fail(e instanceof Error ? e.message : "Could not start the dump job.", 500);
  }
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("job") ?? "";
  const job = getFillJob(id);
  if (!job) return fail("Job not found.", 404);
  return NextResponse.json({ job });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("job") ?? "";
  if (!cancelFillJob(id)) return fail("Only queued jobs can be cancelled.", 409);
  return NextResponse.json({ ok: true });
}
