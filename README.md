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
| Planned values | `.csv`, `.xlsx` with `mrbtsId, lnBtsId, lnCelId` plus any parameter columns (blank rows ignored) |
| Database (optional) | leave empty to export all planned values; otherwise **a pasted link** (default) or uploaded file(s): `.mdb`, `.accdb`, `.rar`, `.zip`, `.xml`, `.xml.gz` - Access database tables (`A_LTE_MRBTS_LNBTS_LNCEL`, `LNCEL_FDD`, `LNCEL_TDD`, `LNCEL_PC`) and archives inside archives are opened automatically |

### Database link

The link is not fixed - paste a new one whenever the database changes. It is downloaded fresh on every run (the last link you
used is remembered in the browser as a convenience).

- **Google Drive:** `…/file/d/<id>/view`, `…/open?id=<id>`, `…/uc?id=<id>` all work. The file must be shared as
  **"Anyone with the link" (Viewer)**. Large-file "can't scan for viruses" pages are handled. Folder links are not supported.
- **Any direct http(s) link** to a .rar / .zip / .mdb / .xml file. The format is detected from the file contents (magic bytes), so a missing or
  wrong extension is fine. Up to 5 links (one per line) can be combined.
- Environment variables (optional): `MAX_DB_MB` (download limit, default 1024), `ALLOW_PRIVATE_URLS=true` (allow links to
  localhost / intranet servers - blocked by default because the download is done by the server).

## Output rules (verified against the hand-made 700, 1800 and 2600 XMLs)

| CSV column | Class | distName |
|------------|-------|----------|
| `angle` | `NOKLTE:LNCEL` | `PLMN-PLMN/MRBTS-x/LNBTS-x/LNCEL-n` |
| `dlRsBoost` | `NOKLTE:LNCEL_FDD` | `…/LNCEL-n/LNCEL_FDD-0` (FDD cells: 700, 1800) |
| `dlSectorBFWeightProfName`, `mMimoSectorBFProfName` | `NOKLTE:LNCEL_TDD` | `…/LNCEL-n/LNCEL_TDD-0` (TDD cells: 2600) |

| `phyCellId` (PCI jobs) | `NOKLTE:LNCEL` | `PLMN-PLMN/MRBTS-x/LNBTS-x/LNCEL-n` |

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
npm run verify       # CSV + expected XML pairs (700/1800/2600 angle+BF jobs and pci700/pci1800/pci2600 PCI jobs)
npm run test:fetch   # the link downloader (local imitation server: redirects, Drive warning page, private file, ...)
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
```

## Notes

- Runs on Node (not edge). Uploads are processed in memory, so run it locally or on a self-hosted server; serverless
  hosts with a ~4.5 MB request limit (e.g. Vercel) will reject a large database.
- The `samples/*.test-db.xml` files are not your real database - they only exist so each CSV reproduces its expected XML.
