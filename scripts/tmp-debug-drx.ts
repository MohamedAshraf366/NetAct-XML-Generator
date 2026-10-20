import fs from "node:fs";
import MDB from "mdb-reader";

const tpl = new MDB(fs.readFileSync("C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/Dump 4G+5G.mdb"));
const lm = tpl.getTable("IMPORT_LIST_MAPPING").getData() as Record<string, unknown>[];
const icf = tpl.getTable("IMPORT_CLASS_FILTER").getData() as Record<string, unknown>[];
for (const c of ["NRBTS_NRCELL_DRXPROFILENRANR", "LTE_MRBTS_LNBTS_LNCEL_DRX"]) {
  console.log("==", c);
  for (const x of lm.filter((v) => String(v.class) === c)) {
    console.log("  LM", x.list_mapping_name, "|", x.list, "| type", x.mapping_type, "| child", x.child_class, "| pre", x.parameter_prefix_list);
  }
  for (const x of icf.filter((v) => String(v.class) === c)) {
    console.log("  ICF", x.class_filter_name, "|", x.raml2_dn_format, "|", x.raml2_dn_parameters);
  }
}
console.log("== LM rows with list drxProfile1..5 any class");
for (const x of lm.filter((v) => /^drxProfile\d$/i.test(String(v.list)))) {
  console.log("  ", x.list_mapping_name, "|", x.class, "|", x.list, "| type", x.mapping_type, "| child", x.child_class, "| pre", String(x.parameter_prefix_list).slice(0, 80));
}
console.log("== LM rows with class NRBTS_MRBTS_NRBTS_NRCELL and list starting drx");
for (const x of lm.filter((v) => String(v.class) === "NRBTS_MRBTS_NRBTS_NRCELL" && /drx/i.test(String(v.list)))) {
  console.log("  ", x.list_mapping_name, "|", x.list, "| type", x.mapping_type, "| child", x.child_class, "| pre", x.parameter_prefix_list);
}
void fs;
