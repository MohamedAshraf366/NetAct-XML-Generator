import fs from "node:fs";
import { spawn } from "node:child_process";
import MDBReader from "mdb-reader";

async function main() {
  const dir = "C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect";
  const src = `${dir}/Dump 4G+5G.mdb`;
  const out = `${dir}/bench-test.mdb`;
  const java = "D:/netact-tmp/tools/jdk-17.0.20.1+1/bin/java.exe";
  const cp = "tools/mdb-fill/classes;tools/mdb-fill/jackcess-5.0.4.jar";
  const N = Number(process.argv[2]) || 100000;

  fs.copyFileSync(src, out);
  const b64 = (v: unknown) => (v === "" ? "!" : Buffer.from(String(v), "utf8").toString("base64"));

  const t0 = Date.now();
  const child = spawn(java, ["-Duser.timezone=UTC", "-cp", cp, "MdbFill", out], { stdio: ["pipe", "inherit", "pipe"] });
  child.stderr!.on("data", (d: Buffer) => process.stderr.write(d));child.stdin!.on("error", () => {});

  const cols = ["mrbtsId", "lnBtsId", "lnCelId", "cellName", "phyCellId", "angle"];
  const chunks: string[] = ["H\tA_LTE_MRBTS_LNBTS_LNCEL\t" + cols.join("\t") + "\n"];
  let sent = 0;
  child.stdin!.on("error", (e) => console.log("stdin error", e.message));
  child.stdin!.on("close", () => console.log("stdin closed, sent bytes:", sent));
  for (let i = 0; i < N; i++) {
    const mrbts = 900000 + i;
    const cel = 1;
    chunks.push("R\tA_LTE_MRBTS_LNBTS_LNCEL\t" + [String(mrbts), mrbts, cel, `CELL_${i}`, i % 500, 90].map(b64).join("\t") + "\n");
    if (chunks.length > 5000) {
      sent += chunks.join("").length;
      child.stdin!.write(chunks.join(""));
      chunks.length = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  chunks.push("E\n");
  sent += chunks.join("").length;
  child.stdin!.write(chunks.join(""));
  child.stdin!.end();

  const code: number = await new Promise((resolve) => child.on("close", resolve));
  const dt = (Date.now() - t0) / 1000;
  const size = fs.statSync(out).size;
  console.log(`rows=${N} javaExit=${code} time=${dt.toFixed(1)}s rate=${Math.round(N / dt)}/s dbsize=${(size / 1048576).toFixed(1)}MB`);

  const reader = new MDBReader(fs.readFileSync(out));
  console.log("rowCount:", reader.getTable("A_LTE_MRBTS_LNBTS_LNCEL").rowCount);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


