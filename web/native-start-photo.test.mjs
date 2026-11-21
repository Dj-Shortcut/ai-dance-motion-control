import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {handleNativeStartPhoto} from './native-start-photo.mjs';
import {nativePath} from './native-api.mjs';

const tester='u-10000000-0000-0000-0000-000000000001';
const other='u-10000000-0000-0000-0000-000000000002';
const jpeg=Uint8Array.of(255,216,255,24,255,217);
const environment={
 RIG_OPENAI_IMAGES_KEY:['sk','fixture'].join('-'),
 RIG_START_PHOTO_MAX_COST_EUR_CENTS:'100',
 RIG_START_PHOTO_TESTERS:`${tester},${other}`,
 RIG_START_PHOTO_EXPIRES_AT:'2099-01-01T00:00:00Z'
};

function fixture(t,{legacyAttempts=0}={}) {
 const sqlite=new DatabaseSync(':memory:');
 t.after(()=>sqlite.close());
 sqlite.exec(readFileSync(new URL('./production-schema.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('./production-migrations/0021_start_photos.sql',import.meta.url),'utf8'));
 for(let i=0;i<legacyAttempts;i++)sqlite.prepare('INSERT INTO rig_start_photo_attempts VALUES (?,?,?)').run('old-'+i,tester,i);
 sqlite.exec(readFileSync(new URL('./production-migrations/0022_start_photo_budget.sql',import.meta.url),'utf8'));
 const db={prepare(sql) {
  const statement=sqlite.prepare(sql);
  return {first:()=>statement.get(),bind(...args) {return {first:()=>statement.get(...args),run:()=>({meta:{changes:statement.run(...args).changes}})};}};
 }};
 const calls=[];
 const network=async (url,init)=>{
  calls.push({url,init});
  return Response.json({data:[{b64_json:btoa(String.fromCharCode(...jpeg))}]});
 };
 const path='https://rig.invalid/api/native/start-photo';
 function run(request,{userId=tester,env=environment,transport=network}={}) {
  return handleNativeStartPhoto(request,env,{db,session:{userId,subjectHash:'a'.repeat(64)},network:transport});
 }
 function request(id,mode='create',image) {
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

test('only allowlisted testers can spend the shared grant before it expires',async t=>{
 const f=fixture(t);
 for (const options of [{userId:'u-10000000-0000-0000-0000-000000000009'},
  {env:{...environment,RIG_START_PHOTO_EXPIRES_AT:'2000-01-01T00:00:00Z'}},
  ...[undefined,'','0','010','0.4','NaN','16701'].map(bound=>({env:{...environment,RIG_START_PHOTO_MAX_COST_EUR_CENTS:bound}})),
  {env:{...environment,RIG_OPENAI_IMAGES_KEY:undefined}}]) {
  assert.deepEqual(await (await f.run(f.status(),options)).json(),{enabled:false,available:false,remaining:0});
  assert.equal((await f.run(f.request(1),options)).status,403);
 }
 assert.equal(f.calls.length,0);
});

test('paid provider calls use fixed image endpoints, with an explicit reference only for edits',async t=>{
 const f=fixture(t);
 const image=new Blob([jpeg],{type:'image/jpeg'});
 assert.equal((await f.run(f.request(2,'edit',new Blob(['invalid'],{type:'image/jpeg'})))).status,400);
 const made=await f.run(f.request(3));
 assert.equal(made.headers.get('content-type'),'image/jpeg');
 assert.deepEqual(new Uint8Array(await made.arrayBuffer()),jpeg);
 assert.equal((await f.run(f.request(4,'edit',image))).status,200);
 assert.deepEqual(f.calls.map(({url})=>url),[
  'https://api.openai.com/v1/images/generations','https://api.openai.com/v1/images/edits'
 ]);
 assert.match(JSON.parse(f.calls[0].init.body).prompt,/discokoning/);
 assert.equal(f.calls[1].init.body.get('image').size,jpeg.length);
 assert.equal(f.calls[1].init.redirect,'error');
 assert.deepEqual(await (await f.run(f.status())).json(),{enabled:true,available:true,remaining:3});
});

test('only a redeemed, credited invitation enables an unlisted customer and frozen accounts cannot spend',async t=>{
 const f=fixture(t);
 const env={...environment,RIG_START_PHOTO_TESTERS:tester,RIG_PRODUCTION_PROMOTIONAL_INVITATION_ENABLED:'yes'};
 const options={env,userId:other};
 f.sqlite.exec("INSERT INTO rig_payment_environment VALUES(1,'live')");
 f.sqlite.prepare(`INSERT INTO rig_production_invitation
  (id,code_hash,amount_cents,created_at,expires_at,source_environment_id,source_invitation_id,source_invalidated_at,redeemed_by,redeemed_at)
  VALUES(1,?,500,10,100,'rig-public-test-v1',1,1,?,20)`).run('a'.repeat(64),other);
 assert.equal((await f.run(f.request(1),options)).status,403);
 f.sqlite.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('promo:rig-first-tester-v1',?,500)").run(other);
 assert.equal((await f.run(f.request(2),options)).status,200);
 f.sqlite.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES (?,'fixture'),(?,'fixture')").run(other,tester);
 assert.equal((await f.run(f.request(3),options)).status,403);
 assert.equal((await f.run(f.request(4),{env})).status,403);
 assert.equal(f.calls.length,1);
});

test('more than three requests per customer can use the same pool, while duplicate submissions reserve only once',async t=>{
 const f=fixture(t);
 const duplicate=await Promise.all([f.run(f.request(1)),f.run(f.request(1))]);
 assert.deepEqual(duplicate.map(response=>response.status).sort(),[200,409]);
 assert.equal((await f.run(f.request(2),{transport:async()=>{throw Error('uncertain');}})).status,502);
 assert.equal((await f.run(f.request(2))).status,409);
 for (let id=3;id<=8;id++) assert.equal((await f.run(f.request(id))).status,200);
 assert.equal((await f.run(f.request(9),{userId:other})).status,200);
 assert.deepEqual(await (await f.run(f.status(),{userId:other})).json(),{enabled:true,available:true,remaining:3});
 assert.equal(f.calls.length,8);
});

test('concurrent customers cannot reserve more than the one lifetime EUR 167 pool, including uncertain charges',async t=>{
 const f=fixture(t),env={...environment,RIG_START_PHOTO_MAX_COST_EUR_CENTS:'8350'};
 let providerCalls=0;
 const uncertain=async()=>{providerCalls++;throw Error('unknown outcome');};
 assert.equal((await f.run(f.request(1),{env,transport:uncertain})).status,502);
 const responses=await Promise.all([
  f.run(f.request(2),{env}),
  f.run(f.request(3),{env,userId:other})
 ]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,429]);
 assert.equal(providerCalls+f.calls.length,2);
 assert.equal(f.sqlite.prepare('SELECT SUM(reserved_eur_cents) AS reserved FROM rig_start_photo_attempts').get().reserved,16700);
 assert.equal((await (await f.run(f.status(),{env,userId:other})).json()).available,false);
 assert.equal((await f.run(f.request(1),{env})).status,409);
 const newPrice={...environment,RIG_START_PHOTO_MAX_COST_EUR_CENTS:'1'};
 assert.equal((await f.run(f.request(4),{env:newPrice})).status,429);
 assert.equal(providerCalls+f.calls.length,2);
});

test('unpriced pre-migration attempts block the pool until accounted for, and legacy Workers cannot insert',async t=>{
 const f=fixture(t,{legacyAttempts:1});
 const available=async()=>(await (await f.run(f.status())).json()).available;
 assert.equal(await available(),false);
 assert.equal((await f.run(f.request(1))).status,429);
 assert.equal(f.calls.length,0);
 f.sqlite.prepare('UPDATE rig_start_photo_attempts SET reserved_eur_cents=16600 WHERE request_id=?').run('old-0');
 const legacy=f.sqlite.prepare('INSERT OR IGNORE INTO rig_start_photo_attempts(request_id,user_id,created_at) VALUES (?,?,?)');
 assert.equal(legacy.run('old-worker',tester,100).changes,0);
 assert.equal(await available(),true);
 assert.equal((await f.run(f.request(2),{userId:other})).status,200);
 assert.equal(await available(),false);
 assert.equal(f.calls.length,1);
});

test('exhausted provider sponsorship is reported without another call',async t=>{
 const f=fixture(t);
 let calls=0;
 const transport=async()=>{calls++;return Response.json({error:{code:'credit_balance_exhausted'}},{status:429});};
 const result=await f.run(f.request(1),{transport});
 assert.equal(result.status,429);
 assert.match((await result.json()).error,/OpenAI-tegoed.*op/);
 assert.equal(calls,1);
});
