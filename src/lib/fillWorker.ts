import fs from "node:fs";
import { buildFillSchema, createFillSink, createRowWriter } from "./fill";
import { parseXmlStream } from "./xmlscan";

const [templatePath, xmlPath, startRaw, endRaw, exportRaw] = process.argv.slice(2);
const start = Number(startRaw);
const end = Number(endRaw);
const exportMs = Number(exportRaw);

function send(message: unknown) {
  if (process.connected) process.send?.(message);
}

async function main() {
  if (!templatePath || !xmlPath || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(exportMs)) {
    throw new Error("usage: fillWorker <template.mdb> <xml> <start> <end> <exportMs>");
  }
  const schema = buildFillSchema(templatePath);
  const ids = new Map([...schema.tableNames].sort().map((name, i) => [name, i + 1]));

  const writeText = (text: string): void | Promise<void> => {
    if (process.stdout.write(text)) return;
    return new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  };
  const writer = createRowWriter(exportMs, writeText, (name) => ids.get(name) ?? 0);

  let objects = 0;
  const { sink, stats, finish } = createFillSink(schema, {
    exportMs,
    emit: writer.write,
    onObject: () => {
      objects++;
      if ((objects & 0x1fff) === 0) {
        send({ type: "progress", objects: stats.objects, rows: stats.parentRows + stats.childRows, bytes: Math.min(src.bytesRead, end - start) });
      }
    },
  });

  const src = fs.createReadStream(xmlPath, { start, end: end - 1, highWaterMark: 4 << 20 });
  await parseXmlStream(src, sink);
  await finish();
  await writer.finish();

  send({
    type: "stats",
    stats: {
      objects: stats.objects,
      parentRows: stats.parentRows,
      childRows: stats.childRows,
      skippedClass: [...stats.skippedClass],
      unknownParams: [...stats.unknownParams],
      unknownLists: [...stats.unknownLists],
    },
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
