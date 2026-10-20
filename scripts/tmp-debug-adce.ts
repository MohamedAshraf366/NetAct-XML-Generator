import { buildFillSchema, resolveClass } from "../src/lib/fill";
const schema = buildFillSchema("C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/Dump 4G+5G.mdb");
const rule = schema.rules.get("adce");
console.log("rules", rule?.map((r) => ({ dbClass: r.dbClass, ids: r.ids, re: String(r.re) })));
const cls = schema.classes.get("ADCE");
console.log("class", cls && { ids: cls.ids, idOffset: cls.idOffset, idRe: String(cls.idRe), table: cls.table.name });
const dn = "PLMN-PLMN/BSC-77777/BCF-327/BTS-979/ADCE-210561947";
console.log("resolve", resolveClass(schema, "ADCE", dn));
console.log("match", cls?.idRe.exec(dn));