/**
 * npm run test:filebuffer - checks the file-backed Buffer against a real Buffer, and runs the
 * committed .mdb fixture through MDBReader with both implementations.
 *
 * The fixture is from mdb-reader's own test suite (MIT):
 * https://github.com/andipaetzold/mdb-reader/blob/main/test/data/V1997/test.mdb
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import MDBReader from "mdb-reader";
import { openFileBuffer } from "../src/lib/fileBuffer";

let pass = 0;
let fail = 0;

function assert(condition: boolean, label: string, detail = "") {
  if (condition) {
    pass++;
    console.log(`PASS  ${label}${detail ? " -> " + detail : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? " -> " + detail : ""}`);
  }
}

const fixturePath = path.join(__dirname, "..", "samples", "fixtures", "mdb-reader-test.mdb");

/** Deterministic pseudo-random integers, so a failure is reproducible. */
function rng(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}

(async () => {
  console.log("=== Testing FileBuffer ===\n");

  assert(fs.existsSync(fixturePath), "Committed .mdb fixture exists");
  if (!fs.existsSync(fixturePath)) {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }

  const fixture = fs.readFileSync(fixturePath);
  const fileBuffer = openFileBuffer(fixturePath, fixture.length);
  try {
    assert(fileBuffer.length === fixture.length, "length matches the file size", `${fileBuffer.length}`);
    assert(fileBuffer[0] === fixture[0], "byte index 0");
    assert(fileBuffer[fixture.length - 1] === fixture[fixture.length - 1], "last byte index");
    assert(fileBuffer[fixture.length] === undefined, "out-of-range index is undefined");
    assert(fileBuffer[fixture.length + 100] === undefined, "far out-of-range index is undefined");

    const edges = [undefined, -fixture.length - 3, -fixture.length, -10, -1, 0, 1, 17, fixture.length - 1, fixture.length, fixture.length + 3];
    let sliceChecks = 0;
    for (const start of edges) {
      for (const end of edges) {
        const expected = fixture.slice(start, end);
        const actual = fileBuffer.slice(start, end);
        if (!actual.equals(expected)) {
          assert(false, `slice(${start}, ${end})`, `${actual.length} vs ${expected.length} bytes`);
        }
        sliceChecks++;
      }
    }
    assert(fail === 0, "slice matches Buffer.slice for edge and negative offsets", `${sliceChecks} combinations`);

    const random = rng(0x5eed);
    const sourceOffsets = [undefined, 0, 1, 7, 1000, fixture.length - 1, fixture.length];
    let copyChecks = 0;
    for (let i = 0; i < 400; i++) {
      const targetLength = random(40);
      const a = Buffer.alloc(targetLength, 0xaa);
      const b = Buffer.alloc(targetLength, 0xaa);
      const targetStarts = [undefined, 0, 1, Math.max(0, targetLength - 1), targetLength];
      const targetStart = targetStarts[random(targetStarts.length)];
      const sourceStart = sourceOffsets[random(sourceOffsets.length)];
      const sourceEnd = sourceOffsets[random(sourceOffsets.length)];
      const expectedN = fixture.copy(a, targetStart, sourceStart, sourceEnd);
      const actualN = fileBuffer.copy(b, targetStart, sourceStart, sourceEnd);
      if (actualN !== expectedN || !b.equals(a)) {
        assert(false, `copy(${targetLength}, ${targetStart}, ${sourceStart}, ${sourceEnd})`, `returned ${actualN} vs ${expectedN}`);
      }
      copyChecks++;
    }
    assert(fail === 0, "copy matches Buffer.copy for edge offsets", `${copyChecks} combinations`);

    const rawReader = new MDBReader(fixture);
    const fileReader = new MDBReader(fileBuffer as unknown as Buffer);
    const opts = { normalTables: true, systemTables: false, linkedTables: false };
    const rawTables = rawReader.getTableNames(opts);
    const fileTables = fileReader.getTableNames(opts);
    assert(JSON.stringify(fileTables) === JSON.stringify(rawTables), "MDBReader table names match", fileTables.join(", "));

    const rawRows = rawReader.getTable("Table1").getData();
    const fileRows = fileReader.getTable("Table1").getData();
    assert(JSON.stringify(fileRows) === JSON.stringify(rawRows), "MDBReader rows match", `${fileRows.length} rows`);
  } finally {
    fileBuffer.close();
    fileBuffer.close(); // close is idempotent
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netact-filebuffer-"));
  const temp = path.join(dir, "random.bin");
  try {
    const size = 4096 + 37;
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = (Math.imul(i, 37) + 11) & 0xff;
    fs.writeFileSync(temp, bytes);

    const fb = openFileBuffer(temp, size);
    try {
      const random = rng(0x1234);
      const half = Math.floor(size / 2);
      let mismatches = 0;
      for (let i = 0; i < 2000; i++) {
        const start = random(size * 2) - half;
        const end = random(size * 2) - half;
        if (!fb.slice(start, end).equals(bytes.slice(start, end))) mismatches++;
      }
      assert(mismatches === 0, "2000 randomized slices match Buffer.slice");
      assert(fb.copy(Buffer.alloc(0)) === 0, "copy into an empty target copies nothing");
    } finally {
      fb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
