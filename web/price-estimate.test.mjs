import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {estimatePrice,handlePriceEstimate} from './price-estimate.mjs';
import ingress from './access-ingress.mjs';

const origin='https://rig.example',aud='audience-0123456789',email='owner@example.com';
const env={DB:{prepare(){return {bind(){return {async first(){return {requests:1}}}}}}},RIG_STAGING_OWNER:'owner01',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_ESTIMATE_PREVIEW_ENABLED:'yes',RIG_ACCESS_INGRESS_ENABLED:'yes',RIG_ACCESS_AUD:aud,RIG_ACCESS_OWNER_EMAIL:email,RIG_PUBLIC_ORIGIN:origin};
const owner={access:{aud,getIdentity:async()=>({email})}};
const req=(query,method='GET')=>new Request(origin+'/api/estimate/fal?'+query,{method});

test('provider estimate matches Mac rounding in USD, with no invented EUR price',()=>{
  let r=estimatePrice('standard',3);assert.equal(r.billedSeconds,3);assert.equal(r.providerEstimate.usdMicros,378000);assert.equal(r.providerEstimate.binding,false);assert.equal(r.customerProposal,null);
  r=estimatePrice('pro',4.01);assert.equal(r.billedSeconds,5);assert.equal(r.providerEstimate.usdMicros,840000);assert.equal(r.providerEstimate.rateCheckedOn,'2026-11-07');
  assert.equal(estimatePrice('pro',Infinity),null);assert.equal(estimatePrice('bogus',3),null);
});
test('only an explicit valid test rate and version create a non-binding EUR proposal',()=>{
  assert.equal(estimatePrice('standard',3,'25',undefined).customerProposal,null);
  assert.equal(estimatePrice('standard',3,'-25','trial').customerProposal,null);
  assert.deepEqual(estimatePrice('standard',3.1,'25','trial').customerProposal,{currency:'EUR',priceCents:100,version:'trial',binding:false});
});
test('estimate route is owner-only, test-only, nonbinding and disallows malformed inputs',async()=>{
  let r=await ingress.fetch(req('quality=standard&duration=3'),env,owner);assert.equal(r.status,200);let b=await r.json();assert.equal(b.providerEstimate.usdMicros,378000);assert.equal(b.customerProposal,null);
  assert.equal((await ingress.fetch(req('quality=standard&duration=3'),env,{})).status,403);
  assert.equal((await ingress.fetch(req('quality=standard&duration=3'),env,{access:{aud,getIdentity:async()=>({email:'other@example.com'})}})).status,403);
  assert.equal((await ingress.fetch(req('quality=standard&duration=3'),{...env,RIG_MODE:'live'},owner)).status,403);
  assert.equal((await ingress.fetch(req('quality=standard&duration=3'),{...env,RIG_ESTIMATE_PREVIEW_ENABLED:'no'},owner)).status,503);
  assert.equal((await ingress.fetch(req('quality=standard&duration=3'),{...env,DB:undefined},owner)).status,503);
  const overLimit={prepare(){return{bind(){return{async first(){return {requests:61}}}}}}};
  assert.equal((await ingress.fetch(req('quality=standard&duration=3'),{...env,DB:overLimit},owner)).status,429);
  assert.equal((await ingress.fetch(req('quality=standard&duration=3','POST'),env,owner)).status,405);
  for(const q of ['quality=standard&duration=NaN','quality=standard&duration=2','quality=standard&duration=31','quality=pro&duration=3&duration=4','quality=standard&duration=3&price=1'])assert.equal((await ingress.fetch(req(q),env,owner)).status,400,q);
  assert.equal((await ingress.fetch(req('quality=standard&duration=30'),env,owner)).status,200);
  assert.equal((await handlePriceEstimate(req('quality=standard&duration=3'),{...env,RIG_MODE:'live'})).status,503);
});
test('web preview displays the provider estimate while explicitly leaving customer price unset',async()=>{
  const elements=new Map();
  function element(id){if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,disabled:false,value:'',duration:0,files:[],listeners:{},addEventListener(type,fn){(this.listeners[type]??=[]).push(fn)},showModal(){},close(){}});return elements.get(id)}
  const quality=element('quality');quality.value='standard';
  element('motionInput').files=[{}];element('motionVideo').duration=5;element('duration').value='3';element('start').value='0';
  const context={document:{getElementById:element,querySelectorAll:()=>[quality],querySelector:()=>quality,addEventListener(){}},window:{},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},fetch:async path=>path==='/api/generations/recent'?Response.json({job:null}):handlePriceEstimate(new Request(origin+path),env),Response,Request,URL,URLSearchParams,Intl,Number,queueMicrotask,setTimeout,clearTimeout};
  runInNewContext(readFileSync(new URL('./frontend/generation-ui.js',import.meta.url),'utf8'),context);
  element('motionVideo').listeners.loadedmetadata[0]();await new Promise(resolve=>setTimeout(resolve,300));
  assert.match(element('providerEstimate').textContent,/0,38/);assert.match(element('providerEstimate').textContent,/klantprijs is nog niet ingesteld/);assert.equal(element('providerEstimate').hidden,false);
  element('duration').value='9';element('duration').listeners.input[0]();assert.equal(element('providerEstimate').hidden,true);
});

test('rapid duplicate estimate events make one request, cache it, and rate limits are explained',async()=>{
  const elements=new Map(),timers=new Map();let timerId=0,requests=0,rateLimited=false;
  function element(id){if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,disabled:false,value:'',duration:0,files:[],listeners:{},addEventListener(type,fn){(this.listeners[type]??=[]).push(fn)},showModal(){},close(){}});return elements.get(id)}
  const quality=element('quality');quality.value='pro';element('motionInput').files=[{}];element('motionVideo').duration=30;element('duration').value='3';element('start').value='0';
  const fakeSetTimeout=fn=>{const id=++timerId;timers.set(id,fn);return id;};
  const ctx={document:{getElementById:element,querySelectorAll:()=>[quality],querySelector:()=>quality,addEventListener(){}},window:{},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},fetch:async path=>{if(path==='/api/generations/recent')return Response.json({job:null});requests++;if(rateLimited)return Response.json({error:'Too many requests'},{status:429});return handlePriceEstimate(new Request(origin+path),env)},Response,Request,URL,URLSearchParams,Intl,Number,queueMicrotask,setTimeout:fakeSetTimeout,clearTimeout:id=>timers.delete(id)};
  runInNewContext(readFileSync(new URL('./frontend/generation-ui.js',import.meta.url),'utf8'),ctx);
  const tick=async()=>{const active=[...timers.values()];timers.clear();for(const fn of active)fn();await new Promise(resolve=>setImmediate(resolve));};
  for(let n=0;n<145;n++){element('duration').value=String(3+n%5);element('duration').listeners.input[0]();element('duration').listeners.change[0]();}
  element('duration').value='3';element('duration').listeners.change[0]();assert.equal(timers.size,1);await tick();assert.equal(requests,1);assert.match(element('providerEstimate').textContent,/0,50/);
  element('start').value='1';element('start').listeners.input[0]();element('start').listeners.change[0]();await tick();assert.equal(requests,1,'start position does not change the price');
  rateLimited=true;element('duration').value='4';element('duration').listeners.input[0]();await tick();assert.equal(requests,2);assert.match(element('providerEstimate').textContent,/Te veel prijsaanvragen/);
  rateLimited=false;element('duration').listeners.change[0]();await tick();assert.equal(requests,3,'a failed request can be retried');assert.match(element('providerEstimate').textContent,/0,67/);
});
