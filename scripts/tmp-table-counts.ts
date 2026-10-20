import fs from "node:fs";
import MDB from "mdb-reader";

const file = process.argv[2];
const db = new MDB(fs.readFileSync(file));
const out: Record<string, number> = {};
for (const name of db.getTableNames()) {
  if (!name.startsWith("A_")) continue;
  try {
    out[name] = (db.getTable(name) as unknown as { rowCount: number }).rowCount;
  } catch {
    out[name] = -1;
  }
}
process.stdout.write(JSON.stringify(out));
