const fs=require('fs');const M=require('mdb-reader').default;const db=new M(fs.readFileSync('C:/Users/ELBOSTAN/AppData/Local/Temp/opencode/dbinspect/Dump 4G+5G.mdb'));
const rows=db.getTable('IMPORT_CLASS_FILTER').getData().filter(r=>r.class_filter_name==='OSS');
const fmts={};for(const r of rows){const f=String(r.raml2_dn_format||'');for(const m of f.matchAll(/%[0-9]*[dsix]/g))fmts[m[0]]=(fmts[m[0]]||0)+1;}
console.log(fmts);
const widths=rows.filter(r=>/%[0-9]+[dsi]/.test(String(r.raml2_dn_format)));console.log('width formats',widths.length);for(const r of widths.slice(0,15))console.log(r.class,JSON.stringify(r.raml2_dn_format),JSON.stringify(r.raml2_dn_parameters));