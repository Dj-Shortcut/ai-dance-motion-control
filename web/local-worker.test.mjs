import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'esbuild';

import {Miniflare} from 'miniflare';
const bearer=token=>({authorization:`Bearer ${token}`});
const createWorker=(dir,enabled)=>new Miniflare({cf:false,d1Persist:join(dir,'d1'),r2Persist:join(dir,'r2'),workers:[
 {name:'ingress',modules:true,scriptPath:join(dir,'ingress.mjs'),compatibilityDate:'2026-01-01',bindings:enabled?{LOCAL_FIXTURE:'yes',RIG_PUBLIC_ORIGIN:'https://rig.local'}:{},serviceBindings:{PRIVATE_ROUTER:'private'}},
 {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',bindings:enabled?{LOCAL_FIXTURE:'yes',RIG_PUBLIC_ORIGIN:'https://rig.local'}:{},d1Databases:{DB:'rig-identity-fixture'},r2Buckets:{BUCKET:'rig-identity-fixture'},serviceBindings:{MOCK_AUTH:'mock-auth',MOCK_FAL:'mock-fal'}},
 {name:'mock-auth',modules:true,scriptPath:join(dir,'mock-auth.mjs'),compatibilityDate:'2026-01-01'},
 {name:'mock-fal',modules:true,scriptPath:join(dir,'mock-fal.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes'},d1Databases:{DB:'rig-identity-fixture'}}
]});
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();}

test('workerd private service and local D1 isolate two users and survive restart',async()=>{
 const directory=await mkdtemp(join(process.cwd(),'.rig-worker-identity-'));let mf;
 try{
  for(const [input,output] of [['local-fixture-ingress.mjs','ingress.mjs'],['local-private-router.mjs','private.mjs'],['local-mock-auth.mjs','mock-auth.mjs'],['local-mock-fal.mjs','mock-fal.mjs']])
   await build({entryPoints:[input],outfile:join(directory,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent',loader:{'.mp4':'base64'}});
  mf=createWorker(directory,false);
  assert.equal((await mf.dispatchFetch('https://rig.local/api/session',{headers:bearer('a.b.c')})).status,503);
  await mf.dispose();mf=createWorker(directory,true);
  let db=await mf.getD1Database('DB','private');for(const file of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./local-video-schema.sql'])await migrate(db,file);
  let response=await mf.dispatchFetch('https://rig.local/api/session',{headers:bearer('a.b.c')});assert.equal(response.status,200,await response.clone().text());const a=(await response.json()).userId;
  response=await mf.dispatchFetch('https://rig.local/api/session',{headers:bearer('d.e.f')});assert.equal(response.status,200);const b=(await response.json()).userId;
  assert.match(a,/^u-/);assert.notEqual(a,b);
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fake1',a,500).run();
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fake2',b,100).run();
  response=await mf.dispatchFetch(`https://rig.local/api/payments/balance?user=${encodeURIComponent(a)}`,{headers:{...bearer('d.e.f'),'oai-authenticated-user-id':a,'x-rig-gateway-user':a}});
  assert.equal(response.status,200);assert.equal((await response.json()).balance,100);
  assert.equal((await mf.dispatchFetch('https://rig.local/api/session')).status,401);
  assert.equal((await mf.dispatchFetch('https://rig.local/api/session',{headers:bearer('z.y.x')})).status,401);
  assert.equal((await mf.dispatchFetch('https://rig.local/api/generations',{method:'POST',headers:bearer('a.b.c')})).status,403);
  assert.equal((await mf.dispatchFetch('https://elsewhere.invalid/api/session',{headers:bearer('a.b.c')})).status,404);
  await mf.dispose();mf=createWorker(directory,true);db=await mf.getD1Database('DB','private');
  response=await mf.dispatchFetch('https://rig.local/api/session',{headers:bearer('a.b.c')});assert.equal((await response.json()).userId,a);
  response=await mf.dispatchFetch('https://rig.local/api/payments/balance',{headers:bearer('a.b.c')});assert.equal((await response.json()).balance,500);
  response=await mf.dispatchFetch('https://rig.local/api/payments/balance',{headers:bearer('d.e.f')});assert.equal((await response.json()).balance,100);
 }finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
