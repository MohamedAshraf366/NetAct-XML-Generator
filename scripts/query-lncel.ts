import fs from "node:fs";
import path from "node:path";
import MDBReader from "mdb-reader";

console.log("Loading cached.mdb...");
const mdbPath = path.join(__dirname, "..", "cached.mdb");
const buf = fs.readFileSync(mdbPath);
console.log(`Read buffer: ${(buf.length / 1048576).toFixed(1)} MB`);

console.log("Initializing MDBReader...");
const reader = new MDBReader(buf);

console.log("Getting table names...");
const allTables = reader.getTableNames({ normalTables: true, systemTables: false, linkedTables: false });
console.log(`Found ${allTables.length} tables`);

// Filter tables containing LNCEL or LNBTS
const lncelTables = allTables.filter((t) => /lncel/i.test(t));
console.log("LNCEL tables:", lncelTables);

const fddTables = allTables.filter((t) => /fdd/i.test(t));
console.log("FDD tables:", fddTables);

const tddTables = allTables.filter((t) => /tdd/i.test(t));
console.log("TDD tables:", tddTables);

// Check row counts and columns of LNCEL tables
for (const t of lncelTables) {
  try {
    const table = reader.getTable(t);
    console.log(`\nTable "${t}": rowCount=${table.rowCount}, columnCount=${table.columnCount}`);
    console.log("Columns:", table.getColumnNames().join(", "));
    if (table.rowCount > 0) {
      const data = table.getData({ rowLimit: 3 });
      console.log("Sample row 0:", JSON.stringify(data[0]));
    }
  } catch (e) {
    console.log(`Error reading table ${t}:`, e);
  }
}
