import fs from "node:fs";
import MDB from "mdb-reader";

const t = new MDB(fs.readFileSync("C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/Dump 4G+5G.mdb")).getTable("A_BSC");
console.log(t.getColumns().filter((c) => /neSwRelease/i.test(c.name)));
