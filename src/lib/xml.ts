import type { Change } from "./types";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Same layout as the NetAct Plan Editor export (CRLF after the XML declaration and at the end). */
export function writeRaml(changes: Change[], name: string, now = new Date()): string {
  const parts: string[] = [
    '<?xml version="1.0"?>\r\n<raml xmlns="raml21.xsd" version="2.1">',
    `<cmData xmlns="" type="plan" scope="changes" name="${escAttr(name)}">`,
    `<header><log user="unknown" action="created" dateTime="${stamp(now)}" appInfo="Nokia NetAct Plan Editor">No description</log></header>`,
  ];
  for (const c of changes) {
    // NetAct lists flat parameters and lists (each treated as a unit named by the list name)
    // in a single alphabetical sequence; every list holds one <item> with all its sub-parameters.
    const groups = new Map<string, typeof c.params>();
    const units: { name: string; params: typeof c.params; isList: boolean }[] = [];
    for (const p of c.params) {
      if (p.group) {
        if (!groups.has(p.group)) groups.set(p.group, []);
        groups.get(p.group)!.push(p);
      } else {
        units.push({ name: p.name, params: [p], isList: false });
      }
    }
    for (const [gname, list] of groups) units.push({ name: gname, params: list, isList: true });

    const ps = units
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((u) => {
        const subs = u.params
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
          .map((p) => `<p name="${escAttr(p.name)}">${esc(p.new)}</p>`)
          .join("");
        return u.isList ? `<list name="${escAttr(u.name)}"><item>${subs}</item></list>` : subs;
      })
      .join("");
    parts.push(
      `<managedObject class="${c.cls}" operation="update" version="${escAttr(c.version)}" distName="${escAttr(c.distName)}">${ps}</managedObject>`,
    );
  }
  parts.push("</cmData></raml>\r\n");
  return parts.join("");
}
