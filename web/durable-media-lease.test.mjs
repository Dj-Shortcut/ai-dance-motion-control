import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createDurableMediaLease} from './durable-media-lease.mjs';
const {Miniflare}=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json')('miniflare');
const worker=dir=>new Miniflare({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB'],d1Persist:join(dir,'d1')});
async function migrate(db,file){const sql=(await readFile(file,'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run()}
test('uncertain transform never expires, double acquisition is excluded and restart keeps the block',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-media-lock-'));let mf,now=100000;
 try{
  mf=worker(dir);let db=await mf.getD1Database('DB');await migrate(db,'cloudflare-migrations/0001_test_baseline.sql');await migrate(db,'closed-payment-migrations/0004_test_media_work_lock.sql');
  let lease=createDurableMediaLease(db,{clock:()=>now});const both=await Promise.all([lease.acquire('alice'),lease.acquire('bob')]);
  assert.equal(both.filter(x=>x.state==='acquired').length,1);assert.equal(both.filter(x=>x.state==='busy').length,1);const token=both.find(x=>x.token).token;
  await lease.complete(token,'uncertain');now+=365*24*60*60*1000;
  assert.deepEqual(await lease.acquire('bob'),{state:'busy'});await assert.rejects(lease.complete(token,'settled'));
  await mf.dispose();mf=worker(dir);db=await mf.getD1Database('DB');lease=createDurableMediaLease(db,{clock:()=>now});assert.deepEqual(await lease.acquire('alice'),{state:'busy'});
  assert.equal((await db.prepare('SELECT state FROM rig_media_work_lock WHERE id=1').first()).state,'uncertain');
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
test('only the matching settled owner token releases and database mode is enforced',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-media-lock-'));let mf;
 try{
  mf=worker(dir);const db=await mf.getD1Database('DB');await migrate(db,'cloudflare-migrations/0001_test_baseline.sql');await migrate(db,'closed-payment-migrations/0004_test_media_work_lock.sql');
  const lease=createDurableMediaLease(db),a=await lease.acquire('alice');assert.equal(a.state,'acquired');
  await assert.rejects(lease.complete(crypto.randomUUID(),'settled'));assert.deepEqual(await lease.acquire('bob'),{state:'busy'});
  await assert.rejects(lease.complete(a.token,'maybe'));await lease.complete(a.token,'settled');assert.equal((await lease.acquire('bob')).state,'acquired');
  await db.prepare("UPDATE rig_payment_environment SET mode='live' WHERE id=1").run();assert.deepEqual(await lease.acquire('carol'),{state:'busy'});
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
