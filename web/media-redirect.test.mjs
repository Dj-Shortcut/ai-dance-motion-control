import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssets} from './assets.mjs';
import {createResultStore} from './results.mjs';

const id='12345678-1234-1234-1234-123456789abc';
const redirection=status=>new Response(null,{status,headers:{Location:'https://attacker.invalid/collect'}});

test('private media binding refuses redirects on both reads and writes',async()=>{
 for(const status of [301,302,303,307,308]){
  const seen=[];let providerCalls=0;
  const a=createAssets({mode:'test',origin:'https://rig.test',mediaSecret:'s'.repeat(32),falKey:'test',limit:async()=>true,authenticate:async()=>({id:'user'}),media:{fetch:async req=>{seen.push(req);return redirection(status)}},providerFetch:async()=>{providerCalls++;throw Error('unexpected provider call')}});
  await assert.rejects(a.getOwned('user',id));
  const req=new Request('https://rig.test/api/assets',{method:'POST',headers:{origin:'https://rig.test','x-rig-asset-kind':'image','content-type':'image/jpeg'},body:'abc'});
  assert.equal((await a.handle(req)).status,503);
  assert.equal(seen.length,2);assert.ok(seen.every(r=>r.redirect==='manual'));assert.equal(providerCalls,0);
 }
});
test('result storage refuses redirected downloads before writing any private object',async()=>{
 for(const status of [301,302,303,307,308]){
  let puts=0,calls=0;const bucket={head:async()=>null,get:async()=>null,put:async()=>{puts++}};
  const store=createResultStore(bucket,async(url,options)=>{calls++;assert.equal(options.redirect,'manual');return redirection(status)});
  await assert.rejects(store.store({id,falRequestId:'request1'},'https://v3b.fal.media/files/b/fixture/result.mp4'));
  assert.equal(calls,1);assert.equal(puts,0);
 }
});
