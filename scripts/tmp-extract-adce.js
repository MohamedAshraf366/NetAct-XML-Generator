const fs=require('fs');
const src='D:/netact-tmp/18-8-2026 xml.xml';
const needle='<managedObject class="ADCE"';
const out='D:/netact-tmp/samples/ADCE-1.xml';
const fd=fs.openSync(src,'r');const buf=Buffer.alloc(4*1024*1024);let carry='';let found=[];let pos=0;
while(found.length<2){const n=fs.readSync(fd,buf,0,buf.length,pos);if(!n)break;pos+=n;const s=carry+buf.subarray(0,n).toString('utf8');let i=0;while(found.length<2){const a=s.indexOf(needle,i);if(a<0)break;const b=s.indexOf('</managedObject>',a);if(b<0)break;found.push(s.slice(a,b+16));i=b+16;}carry=s.slice(-2000);}
fs.closeSync(fd);fs.writeFileSync(out,found.join('\n')+'\n');console.log('blocks',found.length,'bytes',fs.statSync(out).size);