import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {handleNativeStartPhoto} from './native-start-photo.mjs';
import {nativePath} from './native-api.mjs';

const tester='u-10000000-0000-0000-0000-000000000001';
const other='u-10000000-0000-0000-0000-000000000002';
const siteId='appgprj_rig_photo_fixture';
const subjects=new Map([[tester,'a'.repeat(64)],[other,'b'.repeat(64)]]);
const jpeg=Uint8Array.of(255,216,255,192,0,11,8,0,16,0,16,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,255,217);
const usage={input_tokens:110,input_tokens_details:{text_tokens:100,image_tokens:10},output_tokens:300,total_tokens:410};
function imageResponse(report=usage){return Response.json({usage:report,data:[{b64_json:btoa(String.fromCharCode(...jpeg))}]},{headers:{'x-request-id':'req_example'}});}
const environment={
 RIG_PRODUCTION_SITE_ID:siteId,
 RIG_OPENAI_IMAGES_KEY:['sk','fixture'].join('-'),
 RIG_START_PHOTO_SPEND_POLICY:'serialized-150-v1',
 RIG_START_PHOTO_TESTERS:`${tester},${other}`,
 RIG_START_PHOTO_EXPIRES_AT:'2099-01-01T00:00:00Z'
};

function fixture(t,{legacyAttempts=0,legacyCharge,beforeReserve}={}) {
 const sqlite=new DatabaseSync(':memory:');
 t.after(()=>sqlite.close());
 sqlite.exec(readFileSync(new URL('./production-schema.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('./production-migrations/0021_start_photos.sql',import.meta.url),'utf8'));
 for(let i=0;i<legacyAttempts;i++)sqlite.prepare('INSERT INTO rig_start_photo_attempts VALUES (?,?,?)').run('old-'+i,tester,i);
 sqlite.exec(readFileSync(new URL('./production-migrations/0022_start_photo_budget.sql',import.meta.url),'utf8'));
 if (legacyCharge!==undefined) sqlite.prepare('INSERT INTO rig_start_photo_attempts VALUES (?,?,?,?)').run('prior-known',tester,0,legacyCharge);
 sqlite.exec(readFileSync(new URL('./production-migrations/0023_serialized_photo_edits.sql',import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO rig_payment_environment VALUES(1,'live')");
 for (const [userId,subjectHash] of subjects) {
  sqlite.prepare('INSERT INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) VALUES (?,?,?,1)').run(siteId,subjectHash,userId);
 }
 const db={prepare(sql) {
  if (sql.startsWith('INSERT INTO rig_start_photo_edits')) beforeReserve?.(sqlite);
  const statement=sqlite.prepare(sql);
  return {first:()=>statement.get(),bind(...args) {return {first:()=>statement.get(...args),run:()=>({meta:{changes:statement.run(...args).changes}})};}};
 }};
 const calls=[];
 const network=async (url,init)=>{
  calls.push({url,init});
  return imageResponse();
 };
 const path='https://rig.invalid/api/native/start-photo';
 function run(request,{userId=tester,env=environment,transport=network,session={}}={}) {
  return handleNativeStartPhoto(request,env,{db,session:{siteId,userId,subjectHash:subjects.get(userId)??'a'.repeat(64),...session},network:transport});
 }
 function request(id,mode='edit',image=mode==='edit'?new Blob([jpeg],{type:'image/jpeg'}):null) {
  const body=new FormData();
  body.set('requestId',`90000000-0000-0000-0000-${String(id).padStart(12,'0')}`);
  body.set('mode',mode);
  body.set('prompt','Een discokoning');
  if (image) body.set('image',image,'foto.jpg');
  return new Request(path,{method:'POST',body});
 }
 return {run,request,status:()=>new Request(path),calls,sqlite};
}

test('start-photo is available only on the exact native GET and POST endpoints',()=>{
 assert.equal(nativePath('/api/native/start-photo','GET'),true);
 assert.equal(nativePath('/api/native/start-photo','POST'),true);
 for (const path of ['/api/start-photo','/api/native/start-photo?mode=edit','/api/native/start-photo/']) {
  assert.equal(nativePath(path,'POST'),false);
 }
 assert.equal(nativePath('/api/native/start-photo','PUT'),false);
});

test('the campaign verifies the current identity, activation policy and expiry',async t=>{
 const f=fixture(t);
 for (const options of [{userId:'u-10000000-0000-0000-0000-000000000009'},
  {session:{siteId:'unrelated-site'}},{session:{subjectHash:subjects.get(other)}},
  {env:{...environment,RIG_START_PHOTO_EXPIRES_AT:'2000-01-01T00:00:00Z'}},
  {env:{...environment,RIG_START_PHOTO_SPEND_POLICY:undefined,RIG_START_PHOTO_MAX_COST_EUR_CENTS:'1'}},
  {env:{...environment,RIG_OPENAI_IMAGES_KEY:undefined}}]) {
  assert.deepEqual(await (await f.run(f.status(),options)).json(),{enabled:false,available:false,remaining:0,canEdit:false,canCreate:false,waiting:false});
  assert.equal((await f.run(f.request(1),options)).status,403);
 }
 assert.equal(f.calls.length,0);
});

test('an ordinary customer submits the selected JPEG to OpenAI and its usage is booked conservatively',async t=>{
 const f=fixture(t),options={userId:other};
 assert.equal((await (await f.run(f.status(),options)).json()).canEdit,true);
 assert.equal((await f.run(f.request(3,'create'),options)).status,403);
 assert.equal((await f.run(f.request(4,'edit',new Blob(['invalid'],{type:'image/jpeg'})),options)).status,400);
 const oversized=jpeg.slice(); oversized[7]=9;
 assert.equal((await f.run(f.request(5,'edit',new Blob([oversized],{type:'image/jpeg'})),options)).status,400);
 const result=await f.run(f.request(3),options);
 assert.equal(result.status,200);
 assert.deepEqual(new Uint8Array(await result.arrayBuffer()),jpeg);
 assert.equal(f.calls.length,1);
 const {url,init}=f.calls[0];
 assert.equal(url,'https://api.openai.com/v1/images/edits');
 assert.equal(init.redirect,'error');
 assert.equal(init.body.get('model'),'gpt-image-2.6-sunburst');
 assert.equal(init.body.get('n'),'1');
 assert.equal(init.body.get('image').size,jpeg.length);
 const row=f.sqlite.prepare('SELECT * FROM rig_start_photo_edits').get();
 assert.equal(row.request_id,init.headers['X-Client-Request-Id']);
 assert.equal(row.provider_request_id,'req_example');
 assert.deepEqual([row.text_input_tokens,row.image_input_tokens,row.output_tokens,row.cost_usd_micros,row.cost_eur_cents],[100,10,300,9580,1]);
 for (let i=4;i<9;i++) assert.equal((await f.run(f.request(i),options)).status,200);
 assert.equal((await f.run(f.request(3),options)).status,409);
 assert.equal(f.calls.length,6);
});

test('a customer frozen just before admission cannot dispatch an edit',async t=>{
 const f=fixture(t,{beforeReserve:sqlite=>sqlite.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES (?,'fixture')").run(other)});
 const options={userId:other};
 assert.equal((await (await f.run(f.status(),options)).json()).canEdit,true);
 assert.equal((await f.run(f.request(1),options)).status,403);
 assert.equal(f.calls.length,0);
});

test('the last edit is serialized, may cross €150 and then blocks all further calls',async t=>{
 const f=fixture(t,{legacyCharge:14999});
 let started,finish;
 const entered=new Promise(resolve=>{started=resolve;});
 const release=new Promise(resolve=>{finish=resolve;});
 const first=f.run(f.request(1),{transport:async()=>{started();await release;return imageResponse({...usage,output_tokens:999,total_tokens:1109});}});
 await entered;
 assert.equal((await f.run(f.request(2),{userId:other})).status,429);
 assert.equal((await f.run(f.request(1))).status,409);
 assert.deepEqual(await (await f.run(f.status())).json(),{enabled:true,available:true,remaining:3,canEdit:true,canCreate:false,waiting:true});
 assert.equal(f.sqlite.prepare('SELECT unpriced_count FROM rig_start_photo_budget').get().unpriced_count,1);
 finish();assert.equal((await first).status,200);
 const budget=f.sqlite.prepare('SELECT * FROM rig_start_photo_budget').get();
 assert.equal(budget.accounted_eur_cents,15003);
 assert.equal(budget.available_eur_cents,1697);
 assert.equal(budget.may_start,0);
 assert.equal((await f.run(f.request(2),{userId:other})).status,429);
 assert.equal(f.calls.length,0);
});

test('a timeout or provider error keeps the global slot across restarts and both customers',async t=>{
 for (const transport of [async()=>{throw Error('timeout');},async()=>Response.json({error:{code:'credit_balance_exhausted'}},{status:429})]) {
  const f=fixture(t),result=await f.run(f.request(1),{transport});
  assert.ok([429,502].includes(result.status));
  assert.equal((await f.run(f.request(2),{userId:other})).status,429);
  assert.equal(f.sqlite.prepare('SELECT unpriced_count FROM rig_start_photo_budget').get().unpriced_count,1);
  assert.equal(f.calls.length,0);
 }
});

test('valid images with missing, invalid or inconsistent usage are delivered and the pool pauses',async t=>{
 for (const report of [null,{...usage,total_tokens:0},{...usage,input_tokens:99},{...usage,output_tokens_details:{text_tokens:400,image_tokens:0}},
    {...usage,input_tokens_details:{text_tokens:-1,image_tokens:111}}]) {
  const f=fixture(t),result=await f.run(f.request(1),{transport:async()=>imageResponse(report)});
  assert.equal(result.status,200);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()),jpeg);
  assert.equal((await f.run(f.request(2))).status,429);
  assert.equal(f.sqlite.prepare('SELECT cost_eur_cents FROM rig_start_photo_edits').get().cost_eur_cents,null);
 }
});

test('legacy operations fail closed, preserving both unknown historic charges and previous request identifiers',async t=>{
 const f=fixture(t,{legacyAttempts:1});
 assert.equal((await f.run(f.request(1))).status,429);
 assert.equal(f.sqlite.prepare('INSERT INTO rig_start_photo_attempts VALUES (?,?,?,?)').run('old-worker',tester,10,1).changes,0);
 f.sqlite.prepare('UPDATE rig_start_photo_attempts SET reserved_eur_cents=0,request_id=? WHERE request_id=?').run('90000000-0000-0000-0000-000000000001','old-0');
 assert.equal((await f.run(f.request(1))).status,409);
 assert.equal((await f.run(f.request(2))).status,200);
 assert.equal(f.calls.length,1);
});
