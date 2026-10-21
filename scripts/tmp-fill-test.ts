import fs from "node:fs";
import MDBReader from "mdb-reader";
import { buildFillSchema, fillDatabase } from "../src/lib/fill";

const dir = "D:/netact-tmp/dbinspect";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<raml xmlns="raml21.xsd" version="2.1">
  <header>
    <log dateTime="2026-08-18T10:00:00.000+03:00" action="created" appInfo="FDI"/>
  </header>
  <managedObject class="LNCEL" version="x" distName="PLMN-PLMN/MRBTS-99999/LNBTS-99999/LNCEL-1">
    <p name="cellName">A	B
C\\D!</p>
    <p name="phyCellId">101</p>
    <p name="angle">90</p>
    <p name="name">!</p>
    <p name="oldDN">-</p>
  </managedObject>
  <managedObject class="LNADJL" version="x" distName="PLMN-PLMN/MRBTS-99999/LNBTS-99999/LNADJ-1/LNADJL-2">
    <list name="bcPlmnIdList">
      <item><p name="mcc">602</p><p name="mnc">04</p></item>
      <item><p name="mcc">603</p><p name="mnc">05</p></item>
    </list>
    <p name="mcc">602</p>
    <p name="mnc">04</p>
    <p name="phyCellId">493</p>
  </managedObject>
  <managedObject class="NRCELL" version="x" distName="PLMN-PLMN/MRBTS-99999/NRBTS-99999/NRCELL-1">
    <p name="cellName">NR1</p>
    <list name="beamSet">
      <item>
        <p name="basicBeamSet">1</p>
        <p name="beamSetInUse">beamSet_1</p>
        <p name="leftEdgeAngle">60</p>
      </item>
    </list>
    <list name="periodicCsiAcquisition">
      <item><p name="csiReportPeriodicity">320</p><p name="scramblingIdStep">3</p></item>
    </list>
    <list name="dlPtrs">
      <item><p name="actDlPtrs">0</p><p name="dlPtrsFreqDensityThresNrb0">277</p></item>
    </list>
  </managedObject>
  <managedObject class="NTP" version="x" distName="PLMN-PLMN/MRBTS-99999/MNL-1/MNLENT-1/SYNC-1/CLOCK-1/NTP-1">
    <p name="ntpDscp">46</p>
    <list name="ntpServerIpAddrList">
      <p>172.20.24.20</p>
      <p>172.23.11.28</p>
    </list>
  </managedObject>
  <managedObject class="PLMN" version="x" distName="PLMN-PLMN"/>
</raml>`;

async function main() {
  const out = `${dir}/filled-test2.mdb`;
  fs.copyFileSync(`${dir}/Dump 4G+5G.mdb`, out);
  const schema = buildFillSchema(out);
  console.log("schema:", schema.stats, "rules:", schema.rules.size);

  const res = await fillDatabase(
    {
      templatePath: out,
      outPath: out,
      xml: (async function* () {
        yield Buffer.from(xml);
      })(),
    },
    schema,
  );
  console.log("result:", {
    exportTime: res.exportTime,
    objects: res.objects,
    parentRows: res.parentRows,
    childRows: res.childRows,
    errors: res.errors, errorSamples: res.errorSamples, errorTables: res.errorTables,
    skipped: [...res.skippedClass].slice(0, 5),
    unknownParams: [...res.unknownParams].slice(0, 10),
    unknownLists: [...res.unknownLists].slice(0, 10),
  });

  const reader = new MDBReader(fs.readFileSync(out));
  for (const name of [
    "A_LTE_MRBTS_LNBTS_LNCEL",
    "A_LTE_MRBTS_LNBTS_LNADJ_LNADJL",
    "A_LTE_LNADJL_BCPLMNIDLIST",
    "A_NRBTS_MRBTS_NRBTS_NRCELL",
    "A_NRBTS_NRCELL_SCH",
    "A_MNL_MNLENT_SYNC_CLOCK_NTP",
    "A_MNL_NTP_NTPSERVERIPADDRORFQDNLIST",
  ]) {
    try {
      const t = reader.getTable(name);
      const rows = t.getData() as Record<string, unknown>[];
      console.log(name, t.rowCount, rows.slice(0, 3));
    } catch {
      console.log(name, "MISSING");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
