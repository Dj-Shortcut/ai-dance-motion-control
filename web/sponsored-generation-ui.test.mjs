import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not settle')};
function fixture(funding,{price=100,remaining=500,duration=3,mode=funding==='credits'?'live':undefined,providerCosts=funding==='owner',retailPreview={currency:'EUR',priceCents:75,binding:false}}={}){
 const dom=new JSDOM(html,{url:'https://rig.local/',runScripts:'outside-only'}),win=dom.window,d=win.document;
 win.Blob=Blob;win.rigVideoFunding=funding;win.rigVideoMode=mode;win.rigSessionActive=()=>true;
 for(const e of d.querySelectorAll('dialog')){e.showModal=function(){this.open=true};e.close=function(){this.open=false};}
 const store=new Map(),calls=[];let uploads=0;
 win.rigScopedStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 win.rigPreparedMedia=()=>({image:{blob:new Blob(['image'])},video:{blob:new Blob(['video'])},face:null,angles:[],quality:'pro',keepSound:true,steady:false,prompt:'Maak een dansvideo met dezelfde beweging.'});
 // A prepared media object remains identical while a quote is obtained.
 const prepared=win.rigPreparedMedia();win.rigPreparedMedia=()=>prepared;
 win.rigRequest=async(path,opts={})=>{calls.push([path,opts.method||'GET']);let data;
  if(path==='/api/generations/recent')data={job:null};
  else if(path.startsWith('/api/estimate/fal?'))data={quality:'pro',durationSeconds:duration,billedSeconds:duration,customerProposal:retailPreview,...(providerCosts?{providerEstimate:{currency:'USD',usdMicros:504000,binding:false}}:{})};
  else if(path==='/api/sponsor-invitations/status')data={state:'eligible',remainingCents:remaining};
  else if(path==='/api/payments/balance')data={balance:remaining,mode:'live',currency:'EUR',frozen:false};
  else if(path==='/api/assets')data={id:'asset'+(++uploads),status:'ready'};
  else if(path==='/api/generation-quotes')data={id:'q1',currency:'EUR',priceCents:price,durationSeconds:duration===30?30:3.1,billedSeconds:duration===30?30:4,...(providerCosts?{providerEstimateUsdMicros:672000}:{})};
  else throw Error('unexpected request');return {ok:true,json:async()=>data};};
 const motion=d.getElementById('motionVideo');Object.defineProperty(motion,'duration',{value:35,configurable:true});Object.defineProperty(d.getElementById('motionInput'),'files',{value:[{}],configurable:true});
 d.getElementById('duration').value=String(duration);d.getElementById('start').value='0';
 win.eval(script);return {dom,win,d,calls};
}
for(const funding of ['credits','sponsored','owner'])test(`${funding} sees a safe preview and confirmation without starting a generation`,async()=>{
 const f=fixture(funding),{win,d,calls}=f;
 try{
  d.getElementById('motionVideo').dispatchEvent(new win.Event('loadedmetadata'));
  await waitFor(()=>!d.getElementById('providerEstimate').hidden);
  const preview=d.getElementById('providerEstimate').textContent;
  assert.doesNotMatch(preview,/voorstel|aanbevolen|klantprijs/i);
  if(funding==='sponsored'){assert.match(preview,/Raming:.*0,75.*gratis testtegoed/);assert.match(preview,/prijs kan veranderen/);assert.doesNotMatch(preview,/fal|USD|\$/i)}else if(funding==='credits'){assert.match(preview,/Raming:.*0,75.*bevestigt de definitieve prijs/);assert.doesNotMatch(preview,/fal|USD|\$/i)}else {assert.match(preview,/fal.ai-raming/);assert.doesNotMatch(preview,/€/);}
  d.dispatchEvent(new win.Event('rig-prepared-ready'));await waitFor(()=>d.getElementById('uploadDialog').open);
  assert.equal(calls.filter(([p,m])=>p==='/api/assets'&&m==='POST').length,0);
  d.getElementById('confirmUpload').click();await waitFor(()=>!d.getElementById('confirmGeneration').hidden);
  const quote=d.getElementById('quoteMessage').textContent;
  if(funding==='sponsored'){assert.match(quote,/1,00.*gratis testtegoed/);assert.match(quote,/3\.10 seconden/);assert.doesNotMatch(quote,/fal|USD|\$/i)}else if(funding==='credits'){assert.match(quote,/1,00.*RIG-tegoed.*3\.10 seconden/);assert.doesNotMatch(quote,/fal|USD|\$/i)}else assert.match(quote,/fal.ai-raming/);
  assert.equal(calls.filter(([p,m])=>p==='/api/generations'&&m==='POST').length,0);
 }finally{f.dom.window.close()}
});

test('customer retail preview ignores internal provider costs even if an older server still includes them',async()=>{
 const f=fixture('credits',{providerCosts:true});
 try{
  f.d.getElementById('motionVideo').dispatchEvent(new f.win.Event('loadedmetadata'));await waitFor(()=>!f.d.getElementById('providerEstimate').hidden);
  const preview=f.d.getElementById('providerEstimate').textContent;assert.match(preview,/0,75/);assert.doesNotMatch(preview,/fal|USD|\$|0,50|voorstel|klantprijs|aanbevolen/i);
  f.d.dispatchEvent(new f.win.Event('rig-prepared-ready'));await waitFor(()=>f.d.getElementById('uploadDialog').open);f.d.getElementById('confirmUpload').click();await waitFor(()=>!f.d.getElementById('confirmGeneration').hidden);
  assert.match(f.d.getElementById('quoteMessage').textContent,/1,00.*RIG-tegoed/);assert.doesNotMatch(f.d.getElementById('quoteMessage').textContent,/fal|USD|\$|0,672|voorstel|klantprijs|aanbevolen/i);
  assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
 }finally{f.dom.window.close();}
});

test('a missing customer retail estimate cannot fall back to displaying provider cost',async()=>{
 const f=fixture('credits',{providerCosts:true,retailPreview:null});
 try{f.d.getElementById('motionVideo').dispatchEvent(new f.win.Event('loadedmetadata'));await waitFor(()=>!f.d.getElementById('providerEstimate').hidden);assert.match(f.d.getElementById('providerEstimate').textContent,/prijsraming is tijdelijk niet beschikbaar/);assert.doesNotMatch(f.d.getElementById('providerEstimate').textContent,/fal|USD|\$|0,50|klantprijs/i);}finally{f.dom.window.close();}
});

test('unknown funding cannot expose an owner-cost preview or owner-cost quote',async()=>{
 for(const [funding,mode] of [[undefined,undefined],['unrecognised','test'],['owner','live']]){
  const f=fixture(funding,{mode,providerCosts:true});
  try{
   f.d.getElementById('motionVideo').dispatchEvent(new f.win.Event('loadedmetadata'));await new Promise(resolve=>setTimeout(resolve,300));
   assert.equal(f.d.getElementById('providerEstimate').hidden,true);assert.equal(f.d.getElementById('providerEstimate').textContent,'');assert.equal(f.calls.some(([path])=>path.startsWith('/api/estimate/')),false);
   f.d.dispatchEvent(new f.win.Event('rig-prepared-ready'));await waitFor(()=>f.d.getElementById('uploadDialog').open);f.d.getElementById('confirmUpload').click();await waitFor(()=>!f.d.getElementById('confirmGeneration').hidden);
   assert.match(f.d.getElementById('quoteMessage').textContent,/bevestigt.*1,00.*3\.10 seconden/);assert.doesNotMatch(f.d.getElementById('quoteMessage').textContent,/fal|USD|\$|fictief|klantprijs|voorstel/i);
  }finally{f.dom.window.close();}
 }
});

test('a late private-owner estimate stays hidden after its funding capability disappears',async()=>{
 const f=fixture('owner');let finish;
 const request=f.win.rigRequest;f.win.rigRequest=(path,options)=>path.startsWith('/api/estimate/fal?')?new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({quality:'pro',durationSeconds:3,billedSeconds:3,providerEstimate:{currency:'USD',usdMicros:504000,binding:false},customerProposal:{currency:'EUR',priceCents:75,binding:false}})});}):request(path,options);
 try{
  f.d.getElementById('motionVideo').dispatchEvent(new f.win.Event('loadedmetadata'));await waitFor(()=>typeof finish==='function');
  f.win.rigVideoFunding=undefined;finish();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.d.getElementById('providerEstimate').hidden,true);assert.equal(f.d.getElementById('providerEstimate').textContent,'');
 }finally{f.dom.window.close();}
});
test('a thirty-second quote exceeding the actual sponsor budget cannot be confirmed',async()=>{
 const f=fixture('sponsored',{price:750,remaining:500,duration:30}),{win,d,calls}=f;
 try{
  d.dispatchEvent(new win.Event('rig-prepared-ready'));await waitFor(()=>d.getElementById('uploadDialog').open);
  d.getElementById('confirmUpload').click();await waitFor(()=>d.getElementById('quoteMessage').textContent.includes('niet voldoende'));
  assert.equal(d.getElementById('confirmGeneration').hidden,true);d.getElementById('confirmGeneration').click();
  assert.equal(calls.some(([p,m])=>p==='/api/generations'&&m==='POST'),false);
  assert.equal(win.rigScopedStorage.getItem('rig-generation-pending'),null);
 }finally{f.dom.window.close()}
});
