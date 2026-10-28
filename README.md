# NetAct XML Generator — CSV / Excel → NetAct RAML XML

<img width="1366" height="599" alt="image" src="https://github.com/user-attachments/assets/9c889248-a8b2-4e83-8a9c-6abff2708aaf" />

Next.js (App Router) + TypeScript + Tailwind CSS.

Upload a CSV/XLSX of planned cell values and the current network database. The app compares every value with the
database and writes **only the values that differ** to a NetAct "plan" XML (`<cmData type="plan" scope="changes">`).

If you do **not** provide a database at all, the comparison is skipped and **every planned value** is written out as an
update (same XML shape, using the default version).

The landing page (`/`) offers two workflows: **Create XML** (`/create-xml`) for change plans and **Create dump**
(`/fill`) for rebuilding a full Access dump from a RAML export.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
# or: npm run build && npm start
```

## Inputs

| Input | Accepted |
|-------|----------|
| Planned values | `.csv`, `.xlsx` with `mrbtsId, lnBtsId, lnCelId` (LTE) or `mrbtsId, nrBtsId, nrCellId` (5G) plus any parameter columns (blank rows ignored) |
| Database (optional) | leave empty to export all planned values; otherwise uploaded file(s): `.mdb`, `.accdb`, `.rar`, `.zip`, `.xml`, `.xml.gz` - Access database tables (`A_LTE_MRBTS_LNBTS_LNCEL`, `LNCEL_FDD`, `LNCEL_TDD`, `LNCEL_PC`, and the 5G `NRCELL*` tables) and archives inside archives are opened automatically |

### Database upload

Upload the network database to compare against. It can be:

- A NetAct dump: `.mdb` / `.accdb`, or a `.rar` / `.zip` that contains it (archives inside archives are opened too).
- A RAML XML export from NetAct (`.xml`, optionally `.xml.gz`).

Several files can be uploaded at once; the format is detected from the file contents (magic bytes), so a missing or wrong
extension is fine. Only the cells listed in the CSV are read back out of the dump, so a full-network export stays fast and
uses little memory. Files are processed in memory for the request only and are never stored.

Large archives are streamed, not unpacked: a `.rar` is decompressed by the native `unrar` binary (WinRAR's `UnRAR.exe` or
`unrar` on `PATH`, auto-detected) straight into the scan, and a RAML XML export is read chunk by chunk - a 3 GB XML
converts in ~25-45 s with a few hundred MB of RAM. Member names come from `unrar lb`, so the archive itself is never
buffered when it is already on disk. Optional environment variables: `UNRAR_PATH` (explicit unrar binary),
`NO_NATIVE_UNRAR=1` (force the bundled WASM fallback, which buffers the archive and is capped by `MAX_WASM_RAR_MB`,
default 1500), `NETACT_TMP_DIR` (scratch directory) and `MAX_EXTRACT_MB` (largest extracted member, default 3072).
`.mdb` files are read through a file-backed buffer (`src/lib/fileBuffer.ts`),
so only the pages being scanned are in memory rather than the whole file. Large `.xlsx` sheets are read row by row with
ExcelJS's streaming reader; files whose zip layout the streaming reader cannot handle fall back to the in-memory loader.

The API also still accepts database links (`dbUrl` form field, up to 5, one per line) for scripted callers; that path is
handled by `src/lib/fetchDb.ts` (Google Drive links and direct http(s) links) and is covered by `npm run test:fetch`.
Environment variables (optional): `MAX_DB_MB` (download limit, default 1024), `ALLOW_PRIVATE_URLS=true` (allow links to
localhost / intranet servers - blocked by default because the download is done by the server), and
`ALLOW_LOCAL_FILES=true` (allow reading local paths such as `/var/dumps/db.rar`; **off by default**, and the Docker
image sets it to `false`).

## Create a NetAct dump from a full export (`/fill`)

`/fill` creates a ready-to-import Access dump instead of a plan XML. Upload the full RAML XML export (`.xml`,
`.xml.gz`, or a `.rar` containing it) and an empty template dump (`Dump 4G+5G.mdb`). The app creates every managed
object, parameter and nested list in the template's `A_<class>` tables, using the template's own
`IMPORT_CLASS_FILTER` / `IMPORT_PARAMETER_FILTER` / `IMPORT_LIST_MAPPING` rows, then returns a ZIP with the created
`.mdb`. Classes or parameters that the template does not import (hardware inventory, activation counters, ...) are
counted and skipped exactly like NetAct does.

The dump is created inside the Node process, one job at a time, in the background. Large uploads go through the same 8 MB
chunked upload as the converter, so proxies never see a long request body. The XML is streamed into a Java helper
that inserts rows with Jackcess; peak memory stays near the Java heap, independent of the XML size. A 3.3 GB export
creates a ~1.3 GB dump from the 126 MB template in about 3–4 minutes on an 8-thread desktop. A direct `.xml` file is split into byte ranges and parsed by worker processes; `.xml.gz`/`.rar` uploads are first unpacked to a temporary XML (needing free disk equal to the unpacked size) and then use the same parallel path. Workers write in completion order, so when an export contains duplicate key rows the surviving row can differ from a single-stream dump creation; set `MDB_FILL_WORKERS=1` when that must be deterministic.

Requirements:

- **Java 17+**. The app checks `MDB_FILL_JAVA`, `JAVA_HOME`, a portable JRE in `tools/jre`, common installer
  locations and finally `java` on `PATH`. Docker installs a JRE and compiles the helper during the image build; for
  local development compile it once:
  `javac -cp tools/mdb-fill/jackcess-5.0.4.jar -d tools/mdb-fill/classes tools/mdb-fill/MdbFill.java`
- Disk space for the XML, a full copy of the template, and the ZIP (roughly the XML + 2 × the dump). Set
  `NETACT_TMP_DIR` to a volume with enough room; uploads and finished job folders live there.
- `unrar` on `PATH` for `.rar` exports (the Docker image includes it; on Windows the existing UnRAR auto-detection is
  used). Direct `.xml` / `.xml.gz` uploads do not need it.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MDB_FILL_JAVA` | auto-detect | Java executable used by the dump writer |
| `MDB_FILL_CLASSES` | `tools/mdb-fill/classes` | Compiled `MdbFill.class` directory |
| `MDB_FILL_JAR` | `tools/mdb-fill/jackcess-5.0.4.jar` | Jackcess classpath |
| `MDB_FILL_HEAP` | `-Xmx448m` | JVM heap for the writer (lower it to fit small hosts) |
| `MDB_FILL_WORKERS` | `max(2, min(4, CPUs - 1))` | Parallel XML workers; only used when at least 2 are available. GZ/RAR uploads are unpacked to a temp XML first. |
| `MDB_FILL_BATCH` | `500` | Rows buffered per Jackcess batch before insert |
| `NETACT_TMP_DIR` | OS temp dir | Uploads, job folders and ZIPs (must be writable) |
| `MAX_UPLOAD_MB` | `4096` | Maximum assembled upload size |
| `MAX_EXTRACT_MB` | `3072` | Member size cap for the buffered archive fallbacks |

Finished jobs stay downloadable as ZIP for 12 hours (the intermediate `.mdb` is deleted right after zipping). Jobs are
kept in memory: restarting the server cancels running dump creation and removes its temp folder. ZIP uploads are rejected -
upload the XML itself, an XML.gz, or a RAR.

## Output rules (verified against the reference plan XMLs)

| CSV column | Class | distName |
|------------|-------|----------|
| `angle` | `NOKLTE:LNCEL` | `PLMN-PLMN/MRBTS-x/LNBTS-x/LNCEL-n` |
| `dlRsBoost` | `NOKLTE:LNCEL_FDD`, or `NOKLTE:LNCEL_TDD` in TDD exports | `…/LNCEL-n/LNCEL_FDD-0` (FDD) or `…/LNCEL-n/LNCEL_TDD-0` (TDD) |
| `dlSectorBFWeightProfName`, `mMimoSectorBFProfName` | `NOKLTE:LNCEL_TDD` | `…/LNCEL-n/LNCEL_TDD-0` |

| `phyCellId` (PCI jobs) | `NOKLTE:LNCEL` | `PLMN-PLMN/MRBTS-x/LNBTS-x/LNCEL-n` |

| `amleAllowed`, `handoverAllowed`, `removeAllowed` | `NOKLTE:LNREL` | `…/LNCEL-n/LNREL-<lnRelId>` |
| `raNondedPreamb`, `raPreGrASize`, `raSmallVolUl`, `raMsgPoffGrB` | `NOKLTE:LNCEL` | `PLMN-PLMN/MRBTS-x/LNBTS-x/LNCEL-n` |
| `prachCS` | `NOKLTE:LNCEL_FDD` | `…/LNCEL-n/LNCEL_FDD-0` |

### 5G / NR

A file with an `nrCellId` column is treated as a 5G job. The technology is detected from the header, so an NR file never
falls back to the LTE classes (a couple of names, e.g. `angle`, exist in both but target different managed objects).

| CSV column | Class | distName |
|------------|-------|----------|
| `angle`, `dlQam256PowerBackoffSub6`, `ssPbchBlockPower` | `com.nokia.srbts.nrbts:NRCELL` | `PLMN-PLMN/MRBTS-x/NRBTS-x/NRCELL-n` |
| `basicBeamSet`, `beamSetInUse`, `externalAntennaType`, `leftEdgeAngle`, `lowerEdgeAngle`, `nrBtsBeamRefinementP2`, `rightEdgeAngle`, `tiltOffset`, `upperEdgeAngle` | `com.nokia.srbts.nrbts:NRCELL` (list `beamSet`) | same distName |
| `csiReportPeriodicity`, `csirsNumberWithinReportPeriod_Set1`, `csirsPower`, `maxCsirsNumber`, `scramblingIdStep` | `com.nokia.srbts.nrbts:NRCELL` (list `periodicCsiAcquisition`) | same distName |

- The 5G `NRCELL` managed object is split across many tables in the `.mdb` (`A_NRBTS_MRBTS_NRBTS_NRCELL`,
  `A_NRBTS_NRCELL_SCH`, `_SS`, `_DL`, ...). All columns that map to a known NR parameter are merged onto the same distName.
- Partitioned parameters are written as NetAct lists - a single `<item>` per list - interleaved with the flat parameters in
  one alphabetical sequence (`<p name="dlQam256PowerBackoffSub6">`, `<list name="periodicCsiAcquisition">`, `<p name="ssPbchBlockPower">`).
- The NRCELL version defaults to `NRBTSCL24R3_2413_120` (the version of the database object is used when present).

- Every parameter column found in your file is compared (untick any in the UI). `tac` and `pMax` are assumed to be `LNCEL`
  parameters - they have not appeared in a reference XML yet.
- The plan name is free text and is written to the XML exactly as typed (e.g. `pci700`, `ddf`).
- A blank CSV cell means "nothing planned" and is skipped.
- Entries are sorted in plain text order of `distName` (so `LNCEL-10` comes before `LNCEL-9`), exactly like the NetAct export.
- `version` is copied from the database object.
- If a parameter is absent from the database export it is treated as "not set", so the planned value is written as a change.
- Planned values for cells/objects missing from the database are skipped and summarised as a warning
  (e.g. `dlRsBoost` on a TDD cell, which has no `LNCEL_FDD` object).

## Self-check

```bash
npm run verify        # CSV + expected XML pairs (700/1800/2600, pci*, ho, actions and 5g)
npm run test:fetch    # the link downloader (local imitation server: redirects, Drive warning page, private file, ...)
npm run test:mdb      # the committed .mdb fixture, plus the real cached.mdb if present (LTE)
npm run test:filebuffer # file-backed Buffer semantics against a real Buffer and MDBReader
npm run test:big      # the real local archives: parity / inspect / xml / mdb (edit paths at the top of scripts/test-big.ts)
npm run bench         # synthetic large dump: times wantedDistNames / loadDb / buildChanges
```

For every `samples/<name>.csv` with a `samples/<name>.expected.xml`, this builds a stand-in database in which exactly the
cells in the expected XML differ, runs the real pipeline and requires an identical result (timestamp ignored).
It cannot prove the comparison against your *real* database - only the format, mapping, ordering and blank handling.

## Layout

```
src/lib/config.ts   parameter -> class mapping (edit here)
src/lib/input.ts    CSV / XLSX reader
src/lib/archive.ts  streaming ingest: rar / gz / zip / mdb sniffing, native unrar detection
src/lib/xmlscan.ts  streaming RAML XML scanner (full scan + quick inspect)
src/lib/db.ts       database loader, keeps only the cells needed
src/lib/diff.ts     comparison
src/lib/xml.ts      RAML writer
src/app/api/convert/route.ts   POST endpoint
src/components/     UI
samples/            700 / 1800 / 2600: CSV, hand-made expected XML, and *.test-db.xml (SYNTHETIC databases for trying the UI)
scripts/verify.ts   regression check (npm run verify)
scripts/test-big.ts real-archive validation (npm run test:big)
scripts/test-filebuffer.ts  file-backed Buffer tests (npm run test:filebuffer)
scripts/bench.ts    performance benchmark (npm run bench)
```

## Deploying

The app streams the database from disk (archives are decompressed by a native `unrar`/gzip stream, `.mdb` is read
through a file-backed buffer), so a modest Node.js server is enough - but it is **not** suitable for a serverless
platform with a small request-body or execution-time cap. A real `.mdb` / `.rar` dump is far larger than the **4.5 MB**
limit Vercel enforces on Route Handlers/Server Actions, which it rejects before the handler runs (a plain-text `413`,
surfaced in the UI as a "file too large" error). Deploy to Railway, Render, Fly.io, a VPS, or any Docker host instead.

The included `Dockerfile` builds a production image that runs `next start` with the full production dependency tree
(safe for the `node-unrar-js` WASM and the `exceljs` / `mdb-reader` external packages), drops the build cache and the
dev-only packages, **bundles native `unrar` 7.x** (from rarlab) - multi-GB `.rar` dumps are then streamed straight
into the scanner, no memory-capped WASM fallback - and runs as the unprivileged `node` user with local file paths
disabled (`ALLOW_LOCAL_FILES=false`). `.dockerignore` keeps `cached.mdb` / `cached.rar` out of the image.
On plain-Node hosts without Docker, install an `unrar` binary on `PATH` (or point `UNRAR_PATH` at it) for the same
streaming path; otherwise the WASM fallback applies and `.rar` archives above `MAX_WASM_RAR_MB` (default 1500 MB) are
rejected with a clear error.

```bash
# Docker (portable)
docker build -t netact-xml-generator .
docker run -p 3000:3000 netact-xml-generator

# or plain Node on any server / PaaS Node buildpack
npm ci && npm run build && npm start   # honors $PORT
```

Before you push/deploy, confirm the build is clean: `npm run typecheck && npm run verify && npm run build`.

### Railway

Railway picks the `Dockerfile` up automatically - no further configuration is needed. The measured numbers below are
from that image end to end (upload included), with the real archives (57 MB `.rar` holding a 3.0 GB XML, 60 MB `.rar`
holding a 1.3 GB `.mdb`):

- `/api/inspect` of the XML archive: **~26-35 s**, 4.26 M managed objects.
- `/api/convert` (700.csv vs that archive): **~35-56 s** total.
- `/api/inspect` of the mdb archive: **~18-23 s**, 1477 tables.

Sizing: **1 GB RAM is enough** for both real archives. The `.mdb` is read from disk through a file-backed buffer
(`src/lib/fileBuffer.ts`), so only the pages being scanned are in memory: in a 1 GB container the 1.3 GB `.mdb` job
peaks at **~210 MB** of process memory (the rest of the cgroup limit is kernel page cache for the file, which is
reclaimable); the XML path peaks around **0.4-0.5 GB**. (Earlier versions held the whole `.mdb` in RAM and needed
~1.7 GB, which Railway's Trial/Free 1 GB and 512 MB limits killed with a 502.)
Uploaded archives are staged in `/tmp` while streaming (`NETACT_TMP_DIR` overrides the location), so keep about the
compressed download size of ephemeral disk free.

Large uploads survive slow connections: Railway rejects any request whose body takes longer than 5 minutes to arrive,
so database files above 8 MB are uploaded in small chunks (`POST /api/upload`, assembled server-side and deleted right
after the request) instead of one long-running request. A single 57 MB archive now goes through even on a slow uplink,
where a one-shot upload died with `ECONNRESET` after the 5-minute mark.

Memory is also released explicitly: the `dev`/`start` scripts and the image run Node with `--expose-gc`, and each
conversion/inspection collects its buffers right after the response (plus between database files), with a periodic
sweep every 5 minutes. Measured in the container: idle RSS drops back to ~150-180 MB within seconds after even the
1.3 GB-mdb and 3 GB-XML jobs; without it the process kept ~1.5 GB resident until the next natural collection.

Vercel note: if you must use Vercel, only tiny databases work; large uploads are blocked at the platform layer and
cannot be enabled by configuration.

## Notes

- Large databases are streamed from disk: XML is parsed chunk by chunk, and the `.mdb` is read through a file-backed
  buffer, so memory stays around half a gigabyte even for the multi-GB archives. Serverless hosts with a small request
  limit (e.g. Vercel Hobby, ≈4.5 MB) still reject a large database upload at the platform layer.
- The `samples/*.test-db.xml` files are not your real database - they only exist so each CSV reproduces its expected XML.
