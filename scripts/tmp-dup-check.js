const fs=require('fs');const M=require('mdb-reader').default;
function check(file, tables){const db=new M(fs.readFileSync(file));for(const [n,keys] of tables){const t=db.getTable(n);const rows=t.getData();const m=new Map();for(const r of rows){const k=keys.map(x=>String(r[x])).join('|');m.set(k,(m.get(k)||0)+1);}let dup=0,max=0;for(const v of m.values()){if(v>1){dup+=v-1;if(v>max)max=v;}}console.log(file.split('/').pop(),n,'rows',rows.length,'distinct',m.size,'dupRows',dup,'maxMult',max);}}
check('D:/netact-tmp/full-fill.mdb',[
 ['A_MNL_RFRES_RFANTRESULTS',['mrbtsId','mnlId','mnlEntId','testId','rfReqId','rfResId','listId','antlId']],
 ['A_VIMEXT_EXCCU_EXUCE',['nms_id','EXCCUId','EXUCEId']],
 ['A_MNL_MNLENT_TEST_RFREQ_RFRES',['mrbtsId','mnlId','mnlEntId','testId','rfReqId','rfResId']],
 ['A_MNL_NOTE_ATTRIBUTE',['mrbtsId','mnlId','notesId','noteId','listId']],
]);