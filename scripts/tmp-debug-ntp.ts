import { buildFillSchema, parseManagedObjectBody } from "../src/lib/fill";

const s = buildFillSchema("C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/Dump 4G+5G.mdb");
const c = s.classes.get("MNL_MNLENT_SYNC_CLOCK_NTP");
console.log("cls?", !!c, "lists", c ? [...c.lists.keys()] : null, "scalar", c?.scalarLists.map((x) => x.table.name));
const body = Buffer.from(
  '<p name="ntpDscp">46</p><list name="ntpServerIpAddrList"><p>1.1.1.1</p><p>2.2.2.2</p></list>',
);
console.log(parseManagedObjectBody(body));
