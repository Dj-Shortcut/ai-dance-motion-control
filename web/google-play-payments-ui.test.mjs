import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {startGooglePlayPayments} from './frontend/multiuser/google-play-payments.mjs';

const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const configured={enabled:true,accountId:'a'.repeat(64),products:[{productId:'rig_credit_5',creditsCents:500}]};
const details=[{itemId:'rig_credit_5',type:'product',price:{currency:'EUR',value:'5.49'}}];
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
const settle=async predicate=>{for(let index=0;index<100;index++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Google Play fixture did not settle');};

async function fixture({config=configured,catalog=details,purchases=[],confirm,show,consume,frozen=false,serviceAvailable=true,owner=false}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/android/'}),w=dom.window,d=w.document,calls=[],storeCalls=[],completions=[],paymentRequests=[];
 let active=true,balance=500;
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 w.rigPaymentChannel='google-play';w.rigVideoFunding=owner?'owner-provider':'credits';w.rigScopedStorage=Object.freeze({setItem(){throw Error('Purchase tokens must not be stored');}});w.rigSessionActive=()=>active;
 w.rigRequest=async(path,options={})=>{
  calls.push({path,options});
  if(path==='/api/payments/balance')return Response.json({balance,currency:'EUR',mode:'live',frozen});
  if(path==='/api/payments/google-play/config')return Response.json(config);
  if(path==='/api/payments/google-play/confirm'){
   const body=JSON.parse(options.body);if(confirm)return confirm(body);
   balance+=500;return Response.json({state:'credited',creditsCents:500});
  }
  throw Error('Unexpected Android payment path: '+path);
 };
 const service={
  async getDetails(ids){storeCalls.push(['getDetails',ids]);return catalog;},
  async listPurchases(){storeCalls.push(['listPurchases']);return typeof purchases==='function'?purchases():purchases;},
  async consume(token){storeCalls.push(['consume',token]);if(consume)return consume(token);}
 };
 if(serviceAvailable)w.getDigitalGoodsService=async provider=>{storeCalls.push(['service',provider]);return service;};
 const response={details:{purchaseToken:'google-purchase-token-fixture'},async complete(result){completions.push(result);}};
 w.PaymentRequest=class{
  constructor(methods,paymentDetails){paymentRequests.push({methods,paymentDetails});}
  async show(){return show?show():response;}
 };
 const app=startGooglePlayPayments({browser:w});
 await settle(()=>owner||d.getElementById('creditsButton').textContent.includes('5,00'));
 return {dom,w,d,app,calls,storeCalls,paymentRequests,completions,response,deactivate(){active=false;},balance:()=>balance,close(){app.dispose();dom.window.close();}};
}

test('disabled server configuration preserves existing balance and never opens any store or Mollie flow',async()=>{
 const f=await fixture({config:{enabled:false}});
 try{
  await f.app.openCredits();assert.match(f.d.getElementById('creditsButton').textContent,/RIG-tegoed.*5,00/);
  assert.match(f.d.getElementById('creditsMessage').textContent,/nog niet beschikbaar.*bestaande RIG-tegoed/);
  assert.equal(f.storeCalls.length,0);assert.equal(f.paymentRequests.length,0);assert.equal(f.d.getElementById('packageList').children.length,0);
  assert.equal(f.d.getElementById('resumePayment').hidden,true);assert.equal(f.d.getElementById('resumePayment').textContent,'');
  assert.equal(f.calls.some(x=>/create|packages|orders/.test(x.path)),false);
 }finally{f.close();}
});

test('an ordinary browser with no real Digital Goods service cannot offer a purchase',async()=>{
 const f=await fixture({serviceAvailable:false});
 try{await f.app.openCredits();assert.equal(f.d.getElementById('packageList').children.length,0);assert.equal(f.paymentRequests.length,0);assert.match(f.d.getElementById('creditsMessage').textContent,/nog niet beschikbaar/);}finally{f.close();}
});

test('malformed server product/account bindings fail closed before store access',async()=>{
 for(const config of [
  {...configured,accountId:'alice@example.test'},
  {...configured,products:[...configured.products,...configured.products]},
  {...configured,products:[{productId:'rig_credit_5',creditsCents:-500}]},
  {...configured,products:[]}
 ]){
  const f=await fixture({config});try{await f.app.openCredits();assert.equal(f.storeCalls.length,0);assert.equal(f.d.getElementById('packageList').children.length,0);}finally{f.close();}
 }
});

test('Google prices, server account binding and verified entitlement determine the actual purchase flow',async()=>{
 const f=await fixture({catalog:[...details,{itemId:'unlisted_product',price:{currency:'EUR',value:'0.01'}}]});
 try{
  await f.app.openCredits();const button=f.d.getElementById('packageList').firstElementChild;
  assert.equal(f.d.getElementById('packageList').children.length,1);assert.match(button.textContent,/5,00.*tegoed.*5,49/);
  assert.equal(f.paymentRequests.length,0,'opening the dialog does not purchase');button.click();
  await settle(()=>f.completions.length===1);
  assert.equal(f.paymentRequests.length,1);
  assert.deepEqual(f.paymentRequests[0].methods,[{supportedMethods:'https://play.google.com/billing',data:{sku:'rig_credit_5',obfuscatedAccountId:'a'.repeat(64)}}]);
  assert.deepEqual(f.paymentRequests[0].paymentDetails.total.amount,{value:'5.49',currency:'EUR'});
  const confirmed=f.calls.find(x=>x.path==='/api/payments/google-play/confirm');
  assert.deepEqual(JSON.parse(confirmed.options.body),{productId:'rig_credit_5',purchaseToken:'google-purchase-token-fixture'});
  assert.deepEqual(f.storeCalls.filter(x=>x[0]==='consume'),[['consume','google-purchase-token-fixture']]);
  assert.deepEqual(f.completions,['success']);assert.match(f.d.getElementById('creditsButton').textContent,/10,00/);
 }finally{f.close();}
});

for(const reply of [{state:'pending'},{state:'verified'},{state:'credited',creditsCents:5000}])test(`server ${reply.state}/${reply.creditsCents??'none'} cannot consume or fabricate credit`,async()=>{
 const f=await fixture({confirm:()=>Response.json(reply,{status:reply.state==='pending'?202:200})});
 try{
  await f.app.openCredits();f.d.getElementById('packageList').firstElementChild.click();await settle(()=>f.completions.length===1);
  assert.equal(f.storeCalls.some(x=>x[0]==='consume'),false);assert.equal(f.balance(),500);assert.deepEqual(f.completions,['unknown']);
  assert.match(f.d.getElementById('creditsMessage').textContent,/Koop niet opnieuw/);assert.match(f.d.getElementById('creditsButton').textContent,/5,00/);assert.equal(f.d.getElementById('packageList').children.length,0,'uncertain credit must not immediately offer another charge');
 }finally{f.close();}
});

test('account changes while Google UI is open discard its token before backend confirmation',async()=>{
 const pending=deferred(),f=await fixture({show:()=>pending.promise});
 try{
  await f.app.openCredits();f.d.getElementById('packageList').firstElementChild.click();assert.equal(f.paymentRequests.length,1);
  f.deactivate();pending.resolve(f.response);await settle(()=>f.completions.length===1);
  assert.equal(f.calls.some(x=>x.path==='/api/payments/google-play/confirm'),false);assert.equal(f.storeCalls.some(x=>x[0]==='consume'),false);
 }finally{f.close();}
});

test('an old account confirmation response cannot consume a purchase after the session ends',async()=>{
 const pending=deferred(),f=await fixture({confirm:()=>pending.promise});
 try{
  await f.app.openCredits();f.d.getElementById('packageList').firstElementChild.click();await settle(()=>f.calls.some(x=>x.path==='/api/payments/google-play/confirm'));
  const before=f.calls.filter(x=>x.path==='/api/payments/balance').length;f.deactivate();pending.resolve(Response.json({state:'credited',creditsCents:500}));await settle(()=>f.completions.length===1);
  assert.equal(f.storeCalls.some(x=>x[0]==='consume'),false);assert.equal(f.calls.filter(x=>x.path==='/api/payments/balance').length,before);
 }finally{f.close();}
});

test('double clicks cannot open duplicate purchases and cancellation never confirms a token',async()=>{
 const pending=deferred(),f=await fixture({show:()=>pending.promise});
 try{
  await f.app.openCredits();const button=f.d.getElementById('packageList').firstElementChild;button.click();button.click();assert.equal(f.paymentRequests.length,1);
  pending.resolve(Promise.reject(new DOMException('Canceled','AbortError')));await settle(()=>f.d.getElementById('creditsMessage').textContent.includes('geannuleerd'));
  assert.equal(f.calls.some(x=>x.path==='/api/payments/google-play/confirm'),false);assert.equal(f.storeCalls.some(x=>x[0]==='consume'),false);
 }finally{f.close();}
});

test('existing unconsumed purchases recover through the server, not a local success flag',async()=>{
 const f=await fixture({purchases:[{itemId:'rig_credit_5',purchaseToken:'existing-purchase-token'},{itemId:'rig_credit_5',purchaseToken:'existing-purchase-token'},{itemId:'unlisted_product',purchaseToken:'not-our-product-token'}]});
 try{
  await f.app.openCredits();assert.equal(f.calls.filter(x=>x.path==='/api/payments/google-play/confirm').length,1);
  assert.deepEqual(f.storeCalls.filter(x=>x[0]==='consume'),[['consume','existing-purchase-token']]);assert.equal(f.paymentRequests.length,0);assert.match(f.d.getElementById('creditsButton').textContent,/10,00/);
 }finally{f.close();}
});

test('unresolved store purchase listing blocks new purchases and overlapping recovery',async()=>{
 const listing=deferred(),f=await fixture({purchases:()=>listing.promise});
 try{
  const opening=f.app.openCredits();await settle(()=>f.storeCalls.some(x=>x[0]==='listPurchases'));
  const button=f.d.getElementById('packageList').firstElementChild;
  assert.equal(button.disabled,true);assert.equal(f.d.getElementById('creditsButton').disabled,true);assert.equal(f.d.getElementById('refreshPayment').disabled,true);
  button.dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));
  await f.app.openCredits();
  assert.equal(f.paymentRequests.length,0);assert.equal(f.storeCalls.filter(x=>x[0]==='listPurchases').length,1);assert.equal(f.calls.some(x=>x.path==='/api/payments/google-play/confirm'),false);
  listing.resolve([]);await opening;
  assert.equal(button.disabled,false);assert.equal(f.d.getElementById('creditsButton').disabled,false);assert.equal(f.d.getElementById('refreshPayment').disabled,false);
  button.click();await settle(()=>f.completions.length===1);assert.equal(f.paymentRequests.length,1);
 }finally{f.close();}
});

test('an unresolved recovered confirmation cannot admit a new charge before a pending result',async()=>{
 const confirmation=deferred(),f=await fixture({purchases:[{itemId:'rig_credit_5',purchaseToken:'existing-unresolved-token'}],confirm:()=>confirmation.promise});
 try{
  const opening=f.app.openCredits();await settle(()=>f.calls.some(x=>x.path==='/api/payments/google-play/confirm'));
  const button=f.d.getElementById('packageList').firstElementChild;
  assert.equal(button.disabled,true);assert.equal(f.d.getElementById('creditsButton').disabled,true);assert.equal(f.d.getElementById('refreshPayment').disabled,true);
  button.dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));assert.equal(f.paymentRequests.length,0);assert.equal(f.storeCalls.some(x=>x[0]==='consume'),false);
  confirmation.resolve(Response.json({state:'pending'},{status:202}));await opening;
  assert.equal(f.paymentRequests.length,0);assert.equal(f.storeCalls.some(x=>x[0]==='consume'),false);assert.equal(f.d.getElementById('packageList').children.length,0);assert.match(f.d.getElementById('creditsMessage').textContent,/Koop niet opnieuw/);
 }finally{f.close();}
});

test('purchase offers remain blocked until every recovered receipt has settled',async()=>{
 const finalConfirmation=deferred();let confirmations=0;
 const f=await fixture({purchases:[{itemId:'rig_credit_5',purchaseToken:'first-existing-token'},{itemId:'rig_credit_5',purchaseToken:'second-existing-token'}],confirm:()=>++confirmations===1?Response.json({state:'credited',creditsCents:500}):finalConfirmation.promise});
 try{
  const opening=f.app.openCredits();await settle(()=>confirmations===2);
  const button=f.d.getElementById('packageList').firstElementChild;
  assert.equal(button.disabled,true);assert.equal(f.d.getElementById('creditsButton').disabled,true);assert.equal(f.d.getElementById('refreshPayment').disabled,true);
  assert.deepEqual(f.storeCalls.filter(x=>x[0]==='consume'),[['consume','first-existing-token']]);
  button.dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));assert.equal(f.paymentRequests.length,0);
  finalConfirmation.resolve(Response.json({state:'credited',creditsCents:500}));await opening;
  assert.equal(button.disabled,false);assert.equal(f.d.getElementById('creditsButton').disabled,false);assert.equal(f.d.getElementById('refreshPayment').disabled,false);
  assert.deepEqual(f.storeCalls.filter(x=>x[0]==='consume'),[['consume','first-existing-token'],['consume','second-existing-token']]);assert.equal(f.paymentRequests.length,0);
 }finally{f.close();}
});

test('closing the dialog during an uncertain recovery cannot leave stale purchase offers',async()=>{
 const confirmation=deferred(),f=await fixture({purchases:[{itemId:'rig_credit_5',purchaseToken:'closed-dialog-pending-token'}],confirm:()=>confirmation.promise});
 try{
  const opening=f.app.openCredits();await settle(()=>f.calls.some(x=>x.path==='/api/payments/google-play/confirm'));
  f.d.getElementById('closeCredits').click();assert.equal(f.d.getElementById('creditsDialog').open,false);assert.equal(f.d.getElementById('creditsButton').disabled,true);
  confirmation.resolve(Response.json({state:'pending'},{status:202}));await opening;
  assert.equal(f.d.getElementById('packageList').children.length,0);assert.equal(f.paymentRequests.length,0);assert.equal(f.storeCalls.some(x=>x[0]==='consume'),false);assert.equal(f.d.getElementById('creditsButton').disabled,false);
 }finally{f.close();}
});

test('unknown recovery status blocks new purchases and leaves the real token unconsumed',async()=>{
 const f=await fixture({purchases:[{itemId:'rig_credit_5',purchaseToken:'pending-purchase-token'}],confirm:()=>Response.json({state:'pending'},{status:202})});
 try{await f.app.openCredits();assert.equal(f.d.getElementById('packageList').children.length,0);assert.match(f.d.getElementById('creditsMessage').textContent,/Koop niet opnieuw/);assert.equal(f.storeCalls.some(x=>x[0]==='consume'),false);}finally{f.close();}
});

test('frozen and owner-provider accounts do not expose Google purchases',async()=>{
 for(const options of [{frozen:true},{owner:true}]){
  const f=await fixture(options);try{await f.app.openCredits();assert.equal(f.calls.some(x=>x.path==='/api/payments/google-play/config'),false);assert.equal(f.d.getElementById('packageList').children.length,0);assert.equal(f.paymentRequests.length,0);}finally{f.close();}
 }
});
