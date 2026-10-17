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
npm run bench        # synthetic large dump: times wantedDistNames / loadDb / buildChanges
```

For every `samples/<name>.csv` with a `samples/<name>.expected.xml`, this builds a stand-in database in which exactly the
cells in the expected XML differ, runs the real pipeline and requires an identical result (timestamp ignored).
It cannot prove the comparison against your *real* database - only the format, mapping, ordering and blank handling.

## Layout

```
src/lib/config.ts   parameter -> class mapping (edit here)
src/lib/input.ts    CSV / XLSX reader
src/lib/db.ts       database loader (xml / gz / zip / rar), keeps only the cells needed
src/lib/diff.ts     comparison
src/lib/xml.ts      RAML writer
src/app/api/convert/route.ts   POST endpoint
src/components/     UI
samples/            700 / 1800 / 2600: CSV, hand-made expected XML, and *.test-db.xml (SYNTHETIC databases for trying the UI)
scripts/verify.ts   regression check (npm run verify)
scripts/bench.ts    performance benchmark (npm run bench)
```

## Deploying to Vercel

The app runs on the Node.js runtime (not Edge) because it unzips archives and reads Access (`mdb-reader`) / Excel
buffers. The route is already configured with `export const runtime = "nodejs"` and `export const maxDuration = 300`.

Before you push, make sure the large local artefacts never leave your machine - `.gitignore` already excludes
`cached.mdb`, `cached.rar`, `*.test-db.xml`, `.vercel` and `.env*`.

```bash
# one-off check, then deploy
npm run typecheck && npm run verify && npm run build
npx vercel          # preview
npx vercel --prod   # production
```

Important limits to be aware of on **Vercel**:

- **Request body size** is capped (≈4.5 MB on Hobby, 4.5 MB–100 MB by plan). A multi-hundred-MB `.mdb` uploaded through
  the form will be rejected before it reaches the function. For large databases run the app locally / self-hosted, or call
  the API with a `dbUrl` link so the download happens server-side (not bound by the upload limit - but see the next point).
- **Function timeout**: Hobby tops out at 60 s; Pro allows up to 300 s (`maxDuration` above). Loading a ~1.3 GB `.mdb`
  in memory can exceed what a small serverless function allows.
- **Memory**: Hobby functions have ~1 GB. Reading a very large `.mdb` fully into memory may exceed this; prefer a
  smaller export or a self-hosted server.

For heavy real-world databases the intended deployment is a normal Node server (`npm run build && npm start`) rather
than a serverless function.

## Notes

- Uploads are processed in memory, so run it locally or on a self-hosted server for large databases; serverless
  hosts with a small request limit (e.g. Vercel Hobby, ≈4.5 MB) will reject a large database upload.
- The `samples/*.test-db.xml` files are not your real database - they only exist so each CSV reproduces its expected XML.
