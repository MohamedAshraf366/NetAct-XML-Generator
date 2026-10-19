import fs from "node:fs";

/**
 * A read-only, file-backed stand-in for the Buffer that `mdb-reader` keeps for random access.
 * mdb-reader only ever uses `.length`, `.copy()`, `.slice()` and byte indexing on that buffer
 * (`Database`), so the whole .mdb never has to sit in RAM: pages are read from disk on demand.
 * `slice()` returns a normal Buffer, which is what the page parsers operate on.
 */
export type FileBuffer = Buffer & { close: () => void };

export function openFileBuffer(filePath: string, size: number): FileBuffer {
  const fd = fs.openSync(filePath, "r");
  let closed = false;

  const readRange = (start: number, end: number): Buffer => {
    const len = Math.max(0, Math.min(end, size) - Math.max(0, start));
    const out = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, out, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return off === len ? out : out.subarray(0, off);
  };

  const api = {
    length: size,
    slice: (start = 0, end: number = size) => {
      const s = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
      const e = end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
      return readRange(s, Math.max(s, e));
    },
    copy: (target: Buffer, targetStart = 0, sourceStart = 0, sourceEnd: number = size) =>
      readRange(sourceStart, sourceEnd).copy(target, targetStart),
    close: () => {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };

  return new Proxy(api as unknown as FileBuffer, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = Number(prop);
        if (i >= size) return undefined;
        const b = readRange(i, i + 1);
        return b.length ? b[0] : undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
