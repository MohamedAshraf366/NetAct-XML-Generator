import fs from "node:fs";
import MDB from "mdb-reader";

const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
const mine = new MDB(fs.readFileSync(`${dir}/prefix-test.mdb`));
const full = new MDB(fs.readFileSync(`${dir}/18-10-2026.mdb`));

const skip = new Set(["last_modified", "last_actual_import", "template_name", "template_set"]);

for (const [table, keys] of [
  ["A_LTE_MRBTS_LNBTS_LNCEL", ["mrbtsId", "lnBtsId", "lnCelId"]],
  ["A_NRBTS_MRBTS_NRBTS_NRCELL", ["mrbtsId", "nrBtsId", "nrCellId"]],
  ["A_NRBTS_NRCELL_SCH", ["mrbtsId", "nrBtsId", "nrCellId"]],
  ["A_MNL_NTP_NTPSERVERIPADDRORFQDNLIST", ["mrbtsId", "ntpId", "listId"]],
] as const) {
  try {
    const a = mine.getTable(table) as unknown as {
      getData: (o?: { rowLimit?: number }) => Record<string, unknown>[];
      getColumns: () => { name: string }[];
      rowCount: number;
    };
    const b = full.getTable(table) as unknown as typeof a;
    const rowsA = a.getData({ rowLimit: 2 });
    const keyCols = new Set(keys as readonly string[]);
    const colsA = new Set(a.getColumns().map((c) => c.name));
    const colsB = new Set(b.getColumns().map((c) => c.name));
    console.log(`\n== ${table} mine=${a.rowCount} full=${b.rowCount}`);
    for (const ra of rowsA) {
      const match = b.getData().find((rb) => keys.every((k) => String(rb[k]) === String(ra[k])));
      if (!match) {
        console.log("  no matching row in full for", keys.map((k) => ra[k]));
        continue;
      }
      const diffs: string[] = [];
      for (const c of a.getColumns()) {
        if (skip.has(c.name) || keyCols.has(c.name) || !colsB.has(c.name)) continue;
        const va = ra[c.name];
        const vb = match[c.name];
        const sa = va === null || va === undefined ? null : String(va);
        const sb = vb === null || vb === undefined ? null : String(vb);
        if (sa !== sb) diffs.push(`${c.name}: ${sa} != ${sb}`);
      }
      console.log(`  keys=${JSON.stringify(keys.map((k) => ra[k]))} diffs=${diffs.length}`, diffs.slice(0, 8));
    }
  } catch (e) {
    console.log(table, "ERR", (e as Error).message);
  }
}
