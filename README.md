# NetAct XML Generator — CSV / Excel → NetAct RAML XML

Next.js (App Router) + TypeScript + Tailwind CSS.

Upload a CSV/XLSX of planned cell values and the current network database. The app compares every value with the
database and writes **only the values that differ** to a NetAct "plan" XML (`<cmData type="plan" scope="changes">`).

If you do **not** provide a database at all, the comparison is skipped and **every planned value** is written out as an
update (same XML shape, using the default version).

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
converts in ~35-45 s with a few hundred MB of RAM. Optional environment variables: `UNRAR_PATH` (explicit unrar binary),
`NO_NATIVE_UNRAR=1` (force the bundled WASM fallback, which buffers the archive and is capped by `MAX_WASM_RAR_MB`,
default 1500), `NETACT_TMP_DIR` (scratch directory) and `MAX_EXTRACT_MB` (largest extracted member, default 3072).
`.mdb` files must still be held in memory by `mdb-reader` (RAM roughly 2-3x the `.mdb` size).

The API also still accepts database links (`dbUrl` form field, up to 5, one per line) for scripted callers; that path is
handled by `src/lib/fetchDb.ts` (Google Drive links, direct http(s) links, local file paths) and is covered by
`npm run test:fetch`. Environment variables (optional): `MAX_DB_MB` (download limit, default 1024),
`ALLOW_PRIVATE_URLS=true` (allow links to localhost / intranet servers - blocked by default because the download is done
by the server).

## Output rules (verified against the hand-made 700, 1800 and 2600 XMLs)

| CSV column | Class | distName |
|------------|-------|----------|
| `angle` | `NOKLTE:LNCEL` | `PLMN-PLMN/MRBTS-x/LNBTS-x/LNCEL-n` |
| `dlRsBoost` | `NOKLTE:LNCEL_FDD` | `…/LNCEL-n/LNCEL_FDD-0` (FDD cells: 700, 1800) |
| `dlSectorBFWeightProfName`, `mMimoSectorBFProfName` | `NOKLTE:LNCEL_TDD` | `…/LNCEL-n/LNCEL_TDD-0` (TDD cells: 2600) |

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
npm run verify       # CSV + expected XML pairs (700/1800/2600, pci*, ho, actions and 5g)
npm run test:fetch   # the link downloader (local imitation server: redirects, Drive warning page, private file, ...)
npm run test:mdb     # reads the real cached.mdb if present (LTE)
npm run test:big     # the real local archives: parity / inspect / xml / mdb (edit paths at the top of scripts/test-big.ts)
npm run bench        # synthetic large dump: times wantedDistNames / loadDb / buildChanges
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
scripts/bench.ts    performance benchmark (npm run bench)
```

## Deploying

The app reads the whole database in memory (it unzips archives and parses Access via `mdb-reader`), so it must run on a
normal Node.js server - **not** a serverless platform with a small request-body cap. A real `.mdb` / `.rar` dump is far
larger than the **4.5 MB** limit Vercel enforces on Route Handlers/Server Actions, which it rejects before the handler
runs (a plain-text `413`, surfaced in the UI as a "file too large" error). Deploy to Railway, Render, Fly.io, a VPS, or
any Docker host instead.

The included `Dockerfile` builds a production image that runs `next start` with the full production dependency tree
(safe for the `node-unrar-js` WASM and the `exceljs` / `mdb-reader` external packages), drops the build cache and the
dev-only packages, and **bundles native `unrar` 7.x** (from rarlab) - multi-GB `.rar` dumps are then streamed straight
into the scanner, no memory-capped WASM fallback. `.dockerignore` keeps `cached.mdb` / `cached.rar` out of the image.
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

- `/api/inspect` of the XML archive: **~26-30 s**, 4.26 M managed objects.
- `/api/convert` (700.csv vs that archive): **~56 s** total.
- `/api/inspect` of the mdb archive: **~18 s**, 1477 tables.

Sizing: give the service **4 GB+ RAM**. The mdb path holds the unpacked `.mdb` plus the reader's structures in memory
(~3 GB peak for a 1.3 GB `.mdb`); the XML path stays around **0.5 GB**. XML-only deployments fit smaller plans.
Uploaded archives are staged in `/tmp` while streaming (`NETACT_TMP_DIR` overrides the location), so keep about the
compressed download size of ephemeral disk free.

Large uploads survive slow connections: Railway rejects any request whose body takes longer than 5 minutes to arrive,
so database files above 8 MB are uploaded in small chunks (`POST /api/upload`, assembled server-side and deleted right
after the request) instead of one long-running request. A single 57 MB archive now goes through even on a slow uplink,
where a one-shot upload died with `ECONNRESET` after the 5-minute mark.

Memory is also released explicitly: the `dev`/`start` scripts and the image run Node with `--expose-gc`, and each
conversion/inspection collects its buffers right after the response (plus between database files), with a periodic
sweep every 5 minutes. Measured in the container: idle RSS drops back to ~180 MB within seconds after even the
1.3 GB-mdb and 3 GB-XML jobs; without it the process kept ~1.5 GB resident until the next natural collection.

Vercel note: if you must use Vercel, only tiny databases work; large uploads are blocked at the platform layer and
cannot be enabled by configuration.

## Notes

- Uploads are processed in memory, so run it locally or on a self-hosted server for large databases; serverless
  hosts with a small request limit (e.g. Vercel Hobby, ≈4.5 MB) will reject a large database upload.
- The `samples/*.test-db.xml` files are not your real database - they only exist so each CSV reproduces its expected XML.
