import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {auditTestCreditLedger} from './credit-ledger-audit.mjs';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec("CREATE TABLE rig_payment_environment(id INTEGER,mode TEXT);INSERT INTO rig_payment_environment VALUES(1,'test');CREATE TABLE rig_generation_jobs(id TEXT PRIMARY KEY,user_id TEXT,state TEXT,price_cents INTEGER,created_at INTEGER);CREATE TABLE rig_ledger(event_id TEXT PRIMARY KEY,user_id TEXT,delta INTEGER)");
 const db={prepare(q){let args=[];return{bind(...v){args=v;return this},async first(){return sql.prepare(q).get(...args)??null},async all(){return{results:sql.prepare(q).all(...args)}}}}};
 return {sql,db};
}
async function sweep(db,user,limit=40){let cursors={},findings=[],orphans=[],count=0,pages=0;do{const page=await auditTestCreditLedger({db,user,limit,cursors});count+=page.jobsExamined;findings.push(...page.findings);orphans.push(...page.orphanedEntries);cursors=page.nextCursors;pages++;assert.ok(pages<20)}while(cursors.jobs!=='done'||cursors.entries!=='done');return {count,findings,orphans,pages}}

test('bounded cursors reach job 101 and all orphan pages while isolating users',async()=>{
 const {sql,db}=fixture();try{
  const jobs=sql.prepare("INSERT INTO rig_generation_jobs VALUES(?,?,'queued',100,1000)"),ledger=sql.prepare('INSERT INTO rig_ledger VALUES(?,?,?)');
  for(let i=0;i<120;i++){const id=`job${String(i).padStart(3,'0')}`;jobs.run(id,'owner');if(i!==101)ledger.run(`reserve:${id}`,'owner',-100);ledger.run(`release:orphan${String(i).padStart(3,'0')}`,'owner',100)}
  jobs.run('otherjob','other');ledger.run('reserve:otherjob','other',-100);ledger.run('reserve:otherorphan','other',-10);
  const result=await sweep(db,'owner');assert.equal(result.count,120);assert.equal(result.pages,3);
  assert.deepEqual(result.findings.map(x=>x.jobId),['job101']);assert.equal(result.orphans.length,120);
  assert.ok(result.orphans.every(x=>!x.includes('other')));
  assert.deepEqual((await sweep(db,'other')).orphans,['reserve:otherorphan']);
 }finally{sql.close()}
});

test('concurrent earlier changes are detected on a new sweep; later keys remain visible on the current sweep',async()=>{
 const {sql,db}=fixture();try{
  const job=sql.prepare("INSERT INTO rig_generation_jobs VALUES(?,?,'queued',100,?)"),ledger=sql.prepare('INSERT INTO rig_ledger VALUES(?,?,?)');
  for(let i=1;i<=3;i++){const id=`job${i}`;job.run(id,'owner',i);ledger.run(`reserve:${id}`,'owner',-100)}
  ledger.run('release:orphan2','owner',100);ledger.run('release:orphan4','owner',100);
  const page=await auditTestCreditLedger({db,user:'owner',limit:1});
  sql.prepare('DELETE FROM rig_ledger WHERE event_id=?').run('reserve:job1');
  ledger.run('release:orphan1','owner',100);ledger.run('release:orphan5','owner',100);
  const second=await auditTestCreditLedger({db,user:'owner',limit:1,cursors:page.nextCursors});
  assert.equal(second.jobsExamined,1);assert.deepEqual(second.orphanedEntries,['release:orphan4']);
  const third=await auditTestCreditLedger({db,user:'owner',limit:1,cursors:second.nextCursors});
  assert.deepEqual(third.orphanedEntries,['release:orphan5']);
  const full=await sweep(db,'owner',1);
  assert.ok(full.findings.some(x=>x.jobId==='job1'));assert.ok(full.orphans.includes('release:orphan1'));
 }finally{sql.close()}
});

test('bad cursor fails closed and finished streams do not repeat',async()=>{
 const {sql,db}=fixture();try{
  await assert.rejects(auditTestCreditLedger({db,user:'owner',cursors:{jobs:{createdAt:0,id:'a',extra:1}}}));
  await assert.rejects(auditTestCreditLedger({db,user:'owner',cursors:{entries:{eventId:123}}}));
  const page=await auditTestCreditLedger({db,user:'owner',cursors:{jobs:'done',entries:'done'}});
  assert.equal(page.jobsExamined,0);assert.deepEqual(page.orphanedEntries,[]);assert.equal(page.truncated,false);
 }finally{sql.close()}
});
