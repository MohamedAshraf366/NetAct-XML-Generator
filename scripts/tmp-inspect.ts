import fs from "node:fs";
import path from "node:path";
import MDBReader from "mdb-reader";

const buf = fs.readFileSync(path.join(__dirname, "..", "cached.mdb"));
const reader = new MDBReader(buf);
const tables = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });

const nr = tables.filter((t) => /NRCELL|NRBTS/i.test(t));
console.log("NR tables:", nr.length);
for (const t of nr) {
  const tb = reader.getTable(t);
  if (tb.rowCount > 0 || /NRCELL$/i.test(t)) {
    console.log(`\n[${t}] rows=${tb.rowCount}`);
    console.log("  " + tb.getColumnNames().join(", "));
  }
}
