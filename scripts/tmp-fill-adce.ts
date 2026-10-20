import fs from "node:fs";
import MDB from "mdb-reader";
import { buildFillSchema, fillDatabase } from "../src/lib/fill";

async function main() {
  const tpl = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/Dump 4G+5G.mdb";
  const out = "D:/netact-tmp/adce-test.mdb";
  fs.copyFileSync(tpl, out);
  const schema = buildFillSchema(out);
  const xml = (async function* () { yield fs.readFileSync("D:/netact-tmp/samples/ADCE-1.xml"); })();
  const res = await fillDatabase({ templatePath: out, outPath: out, xml }, schema);
  console.log(res);
  const db = new MDB(fs.readFileSync(out));
  const rows = (db.getTable("A_ADCE") as any).getData();
  console.log("A_ADCE rows", rows.length);
  for (const r of rows) console.log(JSON.stringify(r));
}
void main();