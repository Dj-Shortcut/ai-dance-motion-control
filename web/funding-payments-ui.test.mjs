import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {publicCommerce} from './commerce-profile.mjs';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8'),script=readFileSync(new URL('./frontend/multiuser/payments.js',import.meta.url),'utf8');
const CHECKOUT='https://www.mollie.com/checkout/existing-owned-payment',PENDING='owned-pending-request-0001',PAID='owned-paid-request-0001';
const wait=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Funding payment UI did not settle');};
const refusal=()=>Response.json({error:'Tegoed kopen is tijdelijk gepauzeerd.',code:'funding_unavailable',paymentCreated:false},{status:503});
async function screen({enabled=true,mode='live',funding='credits',native=true,pending=null,state='open',orders=[],packages=[{id:'five',amountCents:500,credits:500}],commerce=null,createReply=refusal}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),calls=[],redirects=[],downloads=[],storage=new Map(pending?[['rig-payment-request',pending]]:[]);let active=true;
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 w.rigNativeSite=native;w.rigVideoFunding=funding;w.rigSessionActive=()=>active;w.rigScopedStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};w.rigCheckout=async url=>redirects.push(url);
 w.URL.createObjectURL=()=>{const url='blob:owned-receipt-'+downloads.length;downloads.push(url);return url;};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
 const details={mode,currency:'EUR',purchasesEnabled:enabled,frozen:false};
 w.rigRequest=async(path,init={})=>{
  calls.push([path,init]);
  if(path==='/api/payments/balance')return Response.json({...details,balance:500});
  if(path==='/api/payments/packages')return Response.json({...details,packages,...(commerce?{commerce}:{})});
  if(path==='/api/payments/billing')return Response.json({billing:null,electronicDelivery:'rig-download-v1'});
  if(path==='/api/payments/orders')return Response.json({orders});
  if(path.endsWith('/reconcile'))return Response.json({state,...(state==='open'?{checkoutUrl:CHECKOUT}:{})});
  if(path.endsWith('/receipt'))return new Response('<html>Existing owned payment receipt</html>',{headers:{'content-type':'text/html'}});
  if(path==='/api/payments/support-requests')return Response.json({requests:[]});
  if(path==='/api/payments/create')return createReply({body:JSON.parse(init.body),storage});
  throw Error('Unexpected payment UI request '+path);
 };
 w.eval(script);await wait(()=>funding==='owner-provider'?el('creditsButton').textContent==='Eigen fal-account':el('creditsButton').textContent.includes('5,00'));el('creditsButton').click();await wait(()=>el('creditsDialog').open);await new Promise(resolve=>setImmediate(resolve));
 return {dom,w,d,el,calls,redirects,downloads,storage,stop:()=>{active=false;w.rigPaymentsDispose();},close:()=>w.close()};
}
async function buy(f){await wait(()=>f.d.querySelector('.package-button')?.disabled===false);f.d.querySelector('.package-button').click();await wait(()=>f.calls.some(([path])=>path==='/api/payments/create'));}

test('paused new sales preserve existing payment status, Mollie resumption and private receipts',async()=>{
 const f=await screen({enabled:false,pending:PENDING,orders:[{requestId:PAID,state:'paid',amountCents:500,credits:500}]});try{
  assert.equal(f.el('refreshPayment').hidden,false);await wait(()=>!f.el('resumePayment').hidden);assert.equal(f.el('packageList').children.length,0);assert.equal(f.calls.some(([path])=>path==='/api/payments/packages'||path==='/api/payments/create'),false);
  f.el('refreshPayment').click();await wait(()=>f.calls.filter(([path])=>path.endsWith('/reconcile')).length===2);assert.equal(f.storage.get('rig-payment-request'),PENDING);
  const history=f.el('customerHistory');history.open=true;history.dispatchEvent(new f.w.Event('toggle'));await wait(()=>[...history.querySelectorAll('button')].some(button=>button.textContent==='Betalingsbewijs downloaden'));[...history.querySelectorAll('button')].find(button=>button.textContent==='Betalingsbewijs downloaden').click();await wait(()=>f.downloads.length===1);assert.ok(f.calls.some(([path])=>path===`/api/payments/orders/${PAID}/receipt`));
  f.el('resumePayment').click();await wait(()=>f.redirects.length===1);assert.deepEqual(f.redirects,[CHECKOUT]);assert.equal(f.calls.some(([path])=>path==='/api/payments/create'),false);
 }finally{f.close();}
});

test('paused sales without an earlier order show a pause and never create a checkout',async()=>{
 const f=await screen({enabled:false});try{await wait(()=>f.el('creditsMessage').textContent.includes('gepauzeerd'));assert.equal(f.el('refreshPayment').hidden,false);assert.equal(f.el('packageList').children.length,0);assert.equal(f.el('resumePayment').hidden,true);assert.equal(f.storage.size,0);assert.equal(f.calls.some(([path])=>path==='/api/payments/create'),false);}finally{f.close();}
});

test('an exactly matched proven pre-payment funding refusal clears only its own request and shows a pause without retrying',async()=>{
 const f=await screen();try{await buy(f);await wait(()=>f.el('creditsMessage').textContent.includes('gepauzeerd'));assert.equal(f.storage.has('rig-payment-request'),false);assert.doesNotMatch(f.el('creditsMessage').textContent,/onzeker|Controleer de status voordat/);assert.equal(f.el('refreshPayment').hidden,false);assert.equal(f.el('packageList').children.length,0);assert.equal(f.calls.filter(([path])=>path==='/api/payments/create').length,1);assert.equal(f.redirects.length,0);}finally{f.close();}
});

test('ambiguous or nonmatching funding errors keep the pending request until reconciliation',async()=>{
 for(const [status,body] of [[503,{error:'Tijdelijk niet beschikbaar.'}],[503,{code:'funding_unavailable',paymentCreated:true}],[503,{code:'funding_unavailable',paymentCreated:0}],[409,{code:'funding_unavailable',paymentCreated:false}]]){
  const f=await screen({createReply:()=>Response.json(body,{status})});try{await buy(f);await wait(()=>f.el('creditsMessage').textContent.includes('Controleer de status voordat'));const id=JSON.parse(f.calls.find(([path])=>path==='/api/payments/create')[1].body).requestId;assert.equal(f.storage.get('rig-payment-request'),id);assert.equal(f.calls.filter(([path])=>path==='/api/payments/create').length,1);assert.equal(f.redirects.length,0);}finally{f.close();}
 }
});

test('a late proven refusal never removes a different pending request stored in the meantime',async()=>{
 let release;const f=await screen({createReply:()=>new Promise(resolve=>{release=()=>resolve(refusal());})});try{await buy(f);await wait(()=>release);f.storage.set('rig-payment-request','a-newer-owned-request-0002');release();await wait(()=>f.el('creditsMessage').textContent.includes('Controleer de status voordat'));assert.equal(f.storage.get('rig-payment-request'),'a-newer-owned-request-0002');assert.equal(f.calls.filter(([path])=>path==='/api/payments/create').length,1);}finally{f.close();}
});

test('an ended account ignores a late proven refusal and leaves its private recovery handle intact',async()=>{
 let release;const f=await screen({createReply:()=>new Promise(resolve=>{release=()=>resolve(refusal());})});try{await buy(f);await wait(()=>release);const id=f.storage.get('rig-payment-request');f.stop();release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.storage.get('rig-payment-request'),id);assert.equal(f.el('creditsDialog').open,false);assert.equal(f.redirects.length,0);assert.equal(f.calls.filter(([path])=>path==='/api/payments/create').length,1);}finally{f.close();}
});

test('owner-provider and gift funding never gain Mollie recovery controls',async()=>{
 for(const funding of ['owner-provider','sponsored']){const f=await screen({funding,enabled:false,pending:PENDING});try{assert.equal(f.el('refreshPayment').hidden,true);assert.equal(f.el('resumePayment').hidden,true);f.el('refreshPayment').click();assert.equal(f.calls.some(([path])=>path==='/api/payments/orders'||path.endsWith('/reconcile')||path==='/api/payments/create'),false);}finally{f.close();}}
});

test('an unavailable large package stays disabled through consent, billing and payment recovery while a backed small package can be bought',async()=>{
 const f=await screen({packages:[{id:'five',amountCents:500,credits:500,available:true},{id:'twenty-five',amountCents:2500,credits:2500,available:false}],commerce:{...publicCommerce(),required:true,billingRequired:true,electronicDelivery:'rig-download-v1'},createReply:()=>Response.json({checkoutUrl:CHECKOUT})});try{
  await wait(()=>f.el('packageList').children.length===2&&f.el('billing-city'));const [small,large]=f.el('packageList').children,change=(id,value,event='input')=>{f.el(id).value=value;f.el(id).dispatchEvent(new f.w.Event(event));};assert.equal(small.disabled,true);assert.equal(large.disabled,true);
  change('buyerCountry','NL','change');f.el('acceptCommerce').checked=true;f.el('acceptCommerce').dispatchEvent(new f.w.Event('change'));for(const [id,value]of [['billing-name','Test Buyer'],['billing-street','Markt 12'],['billing-postalCode','4331 AB'],['billing-city','Middelburg']])change(id,value);
  await wait(()=>small.disabled===false);assert.equal(large.disabled,true,'consent and completed billing must not reenable an unavailable package');f.el('acceptCommerce').checked=false;f.el('acceptCommerce').dispatchEvent(new f.w.Event('change'));assert.equal(small.disabled,true);assert.equal(large.disabled,true);f.el('acceptCommerce').checked=true;f.el('acceptCommerce').dispatchEvent(new f.w.Event('change'));assert.equal(small.disabled,false);assert.equal(large.disabled,true);
  f.el('refreshPayment').click();await wait(()=>small.disabled===false);assert.equal(large.disabled,true,'recovering payment status must preserve per-package availability');large.click();large.dispatchEvent(new f.w.Event('click'));assert.equal(f.calls.some(([path])=>path==='/api/payments/create'),false);small.click();await wait(()=>f.redirects.length===1);assert.equal(JSON.parse(f.calls.find(([path])=>path==='/api/payments/create')[1].body).packageId,'five');assert.equal(f.calls.filter(([path])=>path==='/api/payments/create').length,1);assert.doesNotMatch(f.el('creditsMessage').textContent,/fal|usd|voorraad|buffer/i);
 }finally{f.close();}
});

test('no available package produces a compact purchase pause and no checkout request',async()=>{
 const f=await screen({packages:[{id:'five',amountCents:500,credits:500,available:false},{id:'ten',amountCents:1000,credits:1000,available:false}]});try{await wait(()=>f.el('packageList').children.length===2);await wait(()=>f.el('creditsMessage').textContent.includes('gepauzeerd'));for(const button of f.el('packageList').children){assert.equal(button.disabled,true);button.dispatchEvent(new f.w.Event('click'));}assert.equal(f.el('refreshPayment').hidden,false);assert.equal(f.calls.some(([path])=>path==='/api/payments/create'),false);assert.doesNotMatch(f.el('creditsMessage').textContent,/fal|usd|voorraad|buffer/i);}finally{f.close();}
});

test('a legacy standalone test package without an availability field still works',async()=>{
 const f=await screen({native:false,mode:'test',createReply:()=>Response.json({checkoutUrl:CHECKOUT})});try{await buy(f);await wait(()=>f.redirects.length===1);assert.equal(f.calls.filter(([path])=>path==='/api/payments/create').length,1);assert.equal(JSON.parse(f.calls.find(([path])=>path==='/api/payments/create')[1].body).packageId,'five');}finally{f.close();}
});
