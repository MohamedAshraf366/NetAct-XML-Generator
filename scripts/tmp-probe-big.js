const fs=require('fs');const M=require('mdb-reader').default;
const db=new M(fs.readFileSync('D:/netact-tmp/full-fill.mdb'));
for(const n of ['A_MNL_RFRES_RFANTRESULTS','A_VIMEXT_EXCCU_EXUCE','A_MNL_MNLENT_TEST_RFREQ_RFRES','A_MNL_NOTE_ATTRIBUTE']){
 const t=db.getTable(n);const cols=t.getColumns().map(c=>c.name);const rows=t.getData({rowLimit:2});
 console.log('\n'+n,'rows',t.rowCount);console.log('cols',cols.join(','));console.log('row',JSON.stringify(rows[0]));
}