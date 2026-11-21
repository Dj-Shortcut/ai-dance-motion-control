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
 RIG_START_PHOTO_TESTERS:`${tester},${other}`,
 RIG_START_PHOTO_EXPIRES_AT:'2099-01-01T00:00:00Z'
};

function fixture(t) {
 const sqlite=new DatabaseSync(':memory:');
 t.after(()=>sqlite.close());
 sqlite.exec(readFileSync(new URL('./production-migrations/0021_start_photos.sql',import.meta.url),'utf8'));
 const db={prepare(sql) {
  const statement=sqlite.prepare(sql);
  return {bind(...args) {return {first:()=>statement.get(...args),run:()=>({meta:{changes:statement.run(...args).changes}})};}};
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
 return {run,request,status:()=>new Request(path),calls};
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

test('sponsored requests have no photo quota while duplicate submissions still cannot spend again',async t=>{
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

test('exhausted provider sponsorship is reported without another call',async t=>{
 const f=fixture(t);
 let calls=0;
 const transport=async()=>{calls++;return Response.json({error:{code:'credit_balance_exhausted'}},{status:429});};
 const result=await f.run(f.request(1),{transport});
 assert.equal(result.status,429);
 assert.match((await result.json()).error,/OpenAI-tegoed.*op/);
 assert.equal(calls,1);
});
