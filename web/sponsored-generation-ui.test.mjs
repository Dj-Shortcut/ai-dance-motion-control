import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not settle')};
function fixture(funding,{price=100,remaining=500,duration=3}={}){
 const dom=new JSDOM(html,{url:'https://rig.local/',runScripts:'outside-only'}),win=dom.window,d=win.document;
 win.Blob=Blob;win.rigVideoFunding=funding;
 for(const e of d.querySelectorAll('dialog')){e.showModal=function(){this.open=true};e.close=function(){this.open=false};}
 const store=new Map(),calls=[];let uploads=0;
 win.rigScopedStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 win.rigPreparedMedia=()=>({image:{blob:new Blob(['image'])},video:{blob:new Blob(['video'])},face:null,angles:[],quality:'pro',keepSound:true,steady:false,prompt:'Maak een dansvideo met dezelfde beweging.'});
 // A prepared media object remains identical while a quote is obtained.
 const prepared=win.rigPreparedMedia();win.rigPreparedMedia=()=>prepared;
 win.rigRequest=async(path,opts={})=>{calls.push([path,opts.method||'GET']);let data;
  if(path==='/api/generations/recent')data={job:null};
  else if(path.startsWith('/api/estimate/fal?'))data={quality:'pro',durationSeconds:duration,billedSeconds:duration,customerProposal:{currency:'EUR',priceCents:75,binding:false},...(funding==='sponsored'?{}:{providerEstimate:{currency:'USD',usdMicros:504000,binding:false}})};
  else if(path==='/api/sponsor-invitations/status')data={state:'eligible',remainingCents:remaining};
  else if(path==='/api/assets')data={id:'asset'+(++uploads),status:'ready'};
  else if(path==='/api/generation-quotes')data={id:'q1',currency:'EUR',priceCents:price,durationSeconds:duration===30?30:3.1,billedSeconds:duration===30?30:4,...(funding==='sponsored'?{}:{providerEstimateUsdMicros:672000})};
  else throw Error('unexpected request');return {ok:true,json:async()=>data};};
 const motion=d.getElementById('motionVideo');Object.defineProperty(motion,'duration',{value:35,configurable:true});Object.defineProperty(d.getElementById('motionInput'),'files',{value:[{}],configurable:true});
 d.getElementById('duration').value=String(duration);d.getElementById('start').value='0';
 win.eval(script);return {dom,win,d,calls};
}
for(const funding of ['sponsored','owner'])test(`${funding} sees a safe preview and confirmation without starting a generation`,async()=>{
 const f=fixture(funding),{win,d,calls}=f;
 try{
  d.getElementById('motionVideo').dispatchEvent(new win.Event('loadedmetadata'));
  await waitFor(()=>!d.getElementById('providerEstimate').hidden);
  const preview=d.getElementById('providerEstimate').textContent;
  if(funding==='sponsored'){assert.match(preview,/Raming:.*0,75.*gratis testtegoed/);assert.match(preview,/prijs kan veranderen/);assert.doesNotMatch(preview,/fal|USD|\$/i)}else assert.match(preview,/fal.ai-raming/);
  d.dispatchEvent(new win.Event('rig-prepared-ready'));await waitFor(()=>d.getElementById('uploadDialog').open);
  assert.equal(calls.filter(([p,m])=>p==='/api/assets'&&m==='POST').length,0);
  d.getElementById('confirmUpload').click();await waitFor(()=>!d.getElementById('confirmGeneration').hidden);
  const quote=d.getElementById('quoteMessage').textContent;
  if(funding==='sponsored'){assert.match(quote,/1,00.*gratis testtegoed/);assert.match(quote,/3\.10 seconden/);assert.doesNotMatch(quote,/fal|USD|\$/i)}else assert.match(quote,/fal.ai-raming/);
  assert.equal(calls.filter(([p,m])=>p==='/api/generations'&&m==='POST').length,0);
 }finally{f.dom.window.close()}
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
