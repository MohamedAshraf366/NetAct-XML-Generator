import fs from "node:fs";
import MDBReader from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const reader = new MDBReader(fs.readFileSync(`${dir}/18-10-2026.mdb`));

function pick(row: Record<string, unknown>, cols: string[]) {
  const o: Record<string, unknown> = {};
  for (const c of cols) o[c] = row[c];
  return o;
}

{
  const t = reader.getTable("A_LTE_MRBTS_LNBTS_LNCEL");
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => Number(r.mrbtsId) === 28942 && Number(r.lnBtsId) === 28942 && Number(r.lnCelId) === 1);
  console.log("\nLNCEL cols:", t.getColumnNames().join(","));
  for (const r of hit) console.log("LNCEL:", JSON.stringify(pick(r, ["mrbtsId", "lnBtsId", "lnCelId", "cellName", "mcc", "mnc", "phyCellId", "template_name", "template_set", "status", "last_modified", "last_actual_import"])));
  console.log("LNCEL has moPrMappingList cols?", t.getColumnNames().filter((c) => /mopr/i.test(c)));
}

{
  const t = reader.getTable("A_LTE_LNADJL_BCPLMNIDLIST");
  console.log("\nBCPLMN cols:", t.getColumnNames().join(","));
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => Number(r.mrbtsId) === 28942 && Number(r.lnBtsId) === 28942 && Number(r.lnAdjId) === 233 && Number(r.lnAdjlId) === 250);
  for (const r of hit) console.log("BCPLMN:", JSON.stringify(r));
}

{
  const t = reader.getTable("A_LTE_MRBTS_LNBTS_LNCEL_LNREL");
  console.log("\nLNREL cols:", t.getColumnNames().join(","));
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => Number(r.mrbtsId) === 28942 && Number(r.lnBtsId) === 28942 && Number(r.lnCelId) === 1 && Number(r.lnRelId) === 374);
  for (const r of hit) console.log("LNREL:", JSON.stringify(pick(r, ["mrbtsId", "lnBtsId", "lnCelId", "lnRelId", "mcc", "mnc", "cellIndOffNeigh", "ecgiAdjEnbId", "ecgiLcrId", "handoverAllowed", "nrStatus", "removeAllowed", "template_name", "template_set", "status", "last_modified", "last_actual_import"])));
}

{
  const t = reader.getTable("A_NRBTS_MRBTS_NRBTS_NRCELL");
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => Number(r.mrbtsId) === 10000 && Number(r.nrbtsId) === 10000 && Number(r.nrCellId) === 10);
  console.log("\nNRCELL cols:", t.getColumnNames().join(","));
  for (const r of hit) console.log("NRCELL:", JSON.stringify(pick(r, ["mrbtsId", "nrbtsId", "nrCellId", "name", "actCsiResAllocOptList", "actCsiResAllocOpt", "actDl256Qam", "template_name", "status", "last_modified", "last_actual_import"])));
}

{
  const t = reader.getTable("A_NRBTS_NRCELL_ACTCSIRESALLOCOPTLIST");
  console.log("\nACTCSIRESALLOC cols:", t.getColumnNames().join(","));
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => Number(r.mrbtsId) === 10000 && Number(r.nrbtsId) === 10000 && Number(r.nrCellId) === 10);
  console.log("rows:", hit.length, JSON.stringify(hit.slice(0, 5)));
}

{
  const t = reader.getTable("A_LTE_MRBTS_LNBTS_LNCEL_SIB");
  console.log("\nSIB cols:", t.getColumnNames().join(","));
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => Number(r.mrbtsId) === 28942 && Number(r.lnBtsId) === 28942 && Number(r.lnCelId) === 1 && Number(r.sibId) === 0);
  for (const r of hit) console.log("SIB:", JSON.stringify(pick(r, ["mrbtsId", "lnBtsId", "lnCelId", "sibId", "cellBarred", "qHyst", "template_name", "status", "last_modified", "last_actual_import"])));
}

{
  const t = reader.getTable("A_LTE_LNCEL_SIBSCHEDULINGLIST");
  console.log("\nSIBSCHED cols:", t.getColumnNames().join(","));
  const rows = t.getData() as Record<string, unknown>[];
  const hit = rows.filter((r) => Number(r.mrbtsId) === 28942 && Number(r.lnBtsId) === 28942 && Number(r.lnCelId) === 1);
  console.log("rows:", hit.length, JSON.stringify(hit.slice(0, 5)));
}
