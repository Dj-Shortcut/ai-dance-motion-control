import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getFalPricePreflight,recastPricePerSecond,RECAST_BILLING} from './price-preflight.mjs';
const edit='fal-ai/kling-video/o3/standard/video-to-video/edit';
function fixture(change=x=>x){const endpoints=[];return {endpoints,fetch:async(url,options)=>{assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(new URL(url).origin,'https://api.fal.ai');const endpoint=new URL(url).searchParams.get('endpoint_id');endpoints.push(endpoint);const price={endpoint_id:endpoint,unit_price:endpoint===edit?0.14:0.1,unit:'seconds',currency:'USD'};return Response.json({prices:change(price)})}};}
test('normal preflight only reads the two existing model prices',async()=>{const f=fixture(x=>[x]);const p=await getFalPricePreflight('fixture-key',f.fetch);assert.equal(f.endpoints.length,2);assert.ok(!f.endpoints.includes(edit));assert.deepEqual(p.prices,{standard:0.1,pro:0.1});});
test('explicit edit preflight requires the exact O3 endpoint and USD per-second unit',async()=>{const f=fixture(x=>[x]);const p=await getFalPricePreflight('fixture-key',f.fetch,{includeEdit:true});assert.equal(f.endpoints.length,3);assert.equal(f.endpoints[2],edit);assert.equal(p.prices['edit-standard'],0.14);assert.equal(p.currency,'USD');assert.equal(p.unit,'second');});
test('missing, duplicate, unrelated or differently billed edit price fails closed',async()=>{
 for(const patch of [x=>[],x=>[x,x],x=>[{...x,endpoint_id:'fal-ai/unrelated'}],x=>[{...x,unit:'video'}],x=>[{...x,currency:'EUR'}],x=>[{...x,unit_price:null}]]){
  const f=fixture(x=>x.endpoint_id===edit?patch(x):[x]);await assert.rejects(getFalPricePreflight('fixture-key',f.fetch,{includeEdit:true}));assert.equal(f.endpoints[2],edit);
 }
});
test('a selected fixed quality reads exactly one bounded endpoint and keeps full default behavior intact',async()=>{
 for(const [quality,endpoint]of [['standard','fal-ai/kling-video/v3/standard/motion-control'],['pro','fal-ai/kling-video/v3/pro/motion-control'],['edit-standard',edit]]){
  const f=fixture(x=>[x]);const p=await getFalPricePreflight('fixture-key',async(url,options)=>{assert.ok(options.signal instanceof AbortSignal);return f.fetch(url,options)},{includeEdit:true,quality});
  assert.deepEqual(f.endpoints,[endpoint]);assert.deepEqual(Object.keys(p.prices),[quality]);
 }
});
test('the quality selector cannot choose an arbitrary model, URL or disabled edit endpoint',async()=>{
 for(const quality of ['https://attacker.invalid','fal-ai/unrelated','__proto__',null,{},'edit-standard']){
  const f=fixture(x=>[x]);await assert.rejects(getFalPricePreflight('fixture-key',f.fetch,{quality}));assert.equal(f.endpoints.length,0);
 }
});
test('Recast explicitly binds the exact endpoint generic-unit baseline to its published 1080P per-output-second contract',async()=>{
 const calls=[],fetcher=async(url,options)=>{const u=new URL(url);calls.push(u.searchParams.get('endpoint_id'));assert.equal(options.redirect,'manual');return Response.json({prices:[{endpoint_id:'minimax/h3-max/recast',currency:'USD',unit:'units',unit_price:.05}]});};
 const p=await getFalPricePreflight('fixture-key',fetcher,{includeRecast:true,quality:'human-recast'});
 assert.deepEqual(calls,['minimax/h3-max/recast']);assert.equal(p.prices['human-recast'],.45);assert.equal(recastPricePerSecond(p),.45);assert.equal(Math.ceil(recastPricePerSecond(p)*1e6)*6,2700000);assert.deepEqual(p.billingContracts['human-recast'],RECAST_BILLING);assert.equal(p.billingContracts['human-recast'].resolution,'1080P');
});
test('Recast cannot be selected by default or fall back from unknown units, changed baseline, currency, model or resolution',async()=>{
 let calls=0;const baseline={endpoint_id:'minimax/h3-max/recast',currency:'USD',unit:'units',unit_price:.05};
 await assert.rejects(getFalPricePreflight('key',async()=>{calls++;},{quality:'human-recast'}));assert.equal(calls,0);
 for(const patch of [{unit:'seconds'},{unit:'second'},{unit:'unit'},{unit_price:.06},{unit_price:.30},{currency:'EUR'},{endpoint_id:'minimax/h3-max/text-to-video'}])await assert.rejects(getFalPricePreflight('key',async()=>Response.json({prices:[{...baseline,...patch}]}),{includeRecast:true,quality:'human-recast'}));
 const valid=await getFalPricePreflight('key',async()=>Response.json({prices:[baseline]}),{includeRecast:true,quality:'human-recast'});
 for(const patch of [{resolution:'768P'},{id:'minimax-h3-max-recast-768p-20261110'},{usdMicrosPerSecond:300000},{usdMicrosPerSecond:50000},{providerUnit:'seconds'},{endpoint:'fal-ai/kling-video/o3/standard/video-to-video/edit'}])assert.throws(()=>recastPricePerSecond({...valid,billingContracts:{'human-recast':{...RECAST_BILLING,...patch}}}));
 assert.throws(()=>recastPricePerSecond({...valid,billingContracts:undefined}));assert.throws(()=>recastPricePerSecond({...valid,unit:'units'}));assert.throws(()=>recastPricePerSecond({...valid,prices:{'human-recast':.05}}));
 assert.throws(()=>recastPricePerSecond({...valid,prices:{'human-recast':.30}}));
});
