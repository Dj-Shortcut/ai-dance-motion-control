import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getFalPricePreflight} from './price-preflight.mjs';
const edit='fal-ai/kling-video/o3/standard/video-to-video/edit';
function fixture(change=x=>x){const endpoints=[];return {endpoints,fetch:async(url,options)=>{assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(new URL(url).origin,'https://api.fal.ai');const endpoint=new URL(url).searchParams.get('endpoint_id');endpoints.push(endpoint);const price={endpoint_id:endpoint,unit_price:endpoint===edit?0.14:0.1,unit:'seconds',currency:'USD'};return Response.json({prices:change(price)})}};}
test('normal preflight only reads the two existing model prices',async()=>{const f=fixture(x=>[x]);const p=await getFalPricePreflight('fixture-key',f.fetch);assert.equal(f.endpoints.length,2);assert.ok(!f.endpoints.includes(edit));assert.deepEqual(p.prices,{standard:0.1,pro:0.1});});
test('explicit edit preflight requires the exact O3 endpoint and USD per-second unit',async()=>{const f=fixture(x=>[x]);const p=await getFalPricePreflight('fixture-key',f.fetch,{includeEdit:true});assert.equal(f.endpoints.length,3);assert.equal(f.endpoints[2],edit);assert.equal(p.prices['edit-standard'],0.14);assert.equal(p.currency,'USD');assert.equal(p.unit,'second');});
test('missing, duplicate, unrelated or differently billed edit price fails closed',async()=>{
 for(const patch of [x=>[],x=>[x,x],x=>[{...x,endpoint_id:'fal-ai/unrelated'}],x=>[{...x,unit:'video'}],x=>[{...x,currency:'EUR'}],x=>[{...x,unit_price:null}]]){
  const f=fixture(x=>x.endpoint_id===edit?patch(x):[x]);await assert.rejects(getFalPricePreflight('fixture-key',f.fetch,{includeEdit:true}));assert.equal(f.endpoints[2],edit);
 }
});
