import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {startGooglePlayPayments} from './frontend/multiuser/google-play-payments.mjs';

const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const KEY='rig-google-play-intent:v1',ACCOUNT='a'.repeat(64),ID='11111111-1111-4111-8111-111111111111';
const configured={enabled:true,recoveryReady:true,mode:'live',currency:'EUR',accountId:ACCOUNT,products:[{productId:'rig_credit_5',creditsCents:500,priceCents:549},{productId:'rig_credit_10',creditsCents:1000,priceCents:1099}]};
const details=[{itemId:'rig_credit_5',type:'product',price:{currency:'EUR',value:'5.49'}},{itemId:'rig_credit_10',type:'product',price:{currency:'EUR',value:'10.99'}}];
const prepared=(overrides={})=>({intentId:ID,productId:'rig_credit_5',accountId:ACCOUNT,expiresAt:Date.now()+900000,state:'prepared',creditsCents:500,consumed:false,recoveryPending:false,newPurchasesBlocked:true,refundPending:false,...overrides});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async predicate=>{for(let index=0;index<150;index++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Google fulfillment UI did not settle');};

async function fixture({config=configured,catalog=details,purchases=[],admit,confirm,status,show,frozen=false,owner=false,serviceAvailable=true,initialIntent=null,initialSlot=null,balance:initialBalance=500,mode='live',storageFailure=false,skipReady=false}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/android/'}),w=dom.window,d=w.document,calls=[],storeCalls=[],completions=[],paymentRequests=[],values=new Map(),rows=new Map(),receipts=new Set(),serverConsumed=[];
 let active=true,balance=initialBalance,latest=null,gesture=false;
 if(initialIntent){rows.set(initialIntent.intentId,{...initialIntent});latest=initialIntent.intentId;}
 if(initialSlot)values.set(KEY,JSON.stringify(initialSlot));
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 w.rigPaymentChannel='google-play';w.rigVideoFunding=owner?'owner-provider':'credits';w.rigSessionActive=()=>active;
 w.rigScopedStorage={
  getItem:key=>values.get(key)??null,
  setItem(key,raw){
   if(storageFailure)throw Error('Storage unavailable');assert.equal(key,KEY);const data=JSON.parse(raw);
   assert.deepEqual(Object.keys(data).sort(),['intentId','requestId']);assert.equal(data.intentId,data.requestId);assert.match(data.intentId,/^[a-f0-9-]{36}$/);
   values.set(key,raw);
  },
  removeItem:key=>values.delete(key)
 };
 const api={
  setIntent(value){rows.set(value.intentId,{...value});latest=value.intentId;},
  getIntent(id=latest){return rows.get(id)??null;},
  setBalance(value){balance=value;},
  credits(body,{consumed=true}={}){
   const row=rows.get(body.intentId);assert.ok(row);assert.equal(row.productId,body.productId);
   if(!receipts.has(body.purchaseToken)){receipts.add(body.purchaseToken);balance+=row.creditsCents;}
   Object.assign(row,{state:'credited',consumed,recoveryPending:!consumed,newPurchasesBlocked:!consumed});
   if(consumed)serverConsumed.push(body.purchaseToken);
   return Response.json({...row});
  }
 };
 w.rigRequest=async(path,options={})=>{
  calls.push({path,options});const url=new URL(path,'https://rig.example.chatgpt.site');
  if(path==='/api/payments/balance')return Response.json({balance,currency:'EUR',mode,frozen});
  if(path==='/api/payments/google-play/config')return Response.json(config);
  if(url.pathname==='/api/payments/google-play/status'){
   const result=status?await status(url.searchParams.get('intentId'),api):api.getIntent(url.searchParams.get('intentId')??undefined);
   return result instanceof Response?result:Response.json({intent:result});
  }
  if(path==='/api/payments/google-play/intents'){
   const body=JSON.parse(options.body);
   if(admit)return admit(body,api);
   let row=rows.get(body.requestId);
   if(!row){const product=config.products.find(p=>p.productId===body.productId);row=prepared({intentId:body.requestId,productId:body.productId,creditsCents:product.creditsCents});api.setIntent(row);}
   return Response.json(row);
  }
  if(path==='/api/payments/google-play/confirm'){
   const body=JSON.parse(options.body);return confirm?confirm(body,api):api.credits(body);
  }
  throw Error('Unexpected Android request: '+path);
 };
 const service={
  async getDetails(ids){storeCalls.push(['getDetails',ids]);return catalog;},
  async listPurchases(){storeCalls.push(['listPurchases']);return typeof purchases==='function'?purchases():purchases;},
  async consume(){storeCalls.push(['CLIENT_CONSUME']);throw Error('Only the server may consume purchases');}
 };
 if(serviceAvailable)w.getDigitalGoodsService=async provider=>{storeCalls.push(['service',provider]);return service;};
 const response={details:{purchaseToken:'google-purchase-token-fixture'},async complete(result){completions.push(result);}};
 w.PaymentRequest=class{
  constructor(methods,paymentDetails){paymentRequests.push({methods,paymentDetails,synchronousGesture:gesture});}
  show(){return show?show():Promise.resolve(response);}
 };
 const app=startGooglePlayPayments({browser:w});if(!skipReady)await app.ready;
 const f={dom,w,d,app,calls,storeCalls,paymentRequests,completions,response,values,rows,serverConsumed,...api,balance:()=>balance,deactivate(){active=false;},close(){app.dispose();dom.window.close();},
  async open(){await app.openCredits();},
  click(button){gesture=true;button.click();gesture=false;},
  async choose(index=0){const button=d.getElementById('packageList').children[index];assert.ok(button);f.click(button);try{await settle(()=>button.textContent.startsWith('Betaal ')&&!button.disabled);}catch(error){throw Error(error.message+' '+JSON.stringify({message:d.getElementById('creditsMessage').textContent,button:button.textContent,disabled:button.disabled,connected:button.isConnected,calls:calls.map(x=>x.path)}));}return button;}
 };
 return f;
}

test('disabled or unsupported Google payment environments preserve balance without offers or Mollie fallback',async()=>{
 for(const options of [{config:{enabled:false}},{serviceAvailable:false}]){
  const f=await fixture(options);try{await f.open();assert.match(f.d.getElementById('creditsButton').textContent,/5,00/);assert.equal(f.paymentRequests.length,0);assert.equal(f.d.getElementById('packageList').children.length,0);assert.equal(f.d.getElementById('resumePayment').hidden,true);assert.equal(f.calls.some(x=>/\/create|\/packages|\/orders/.test(x.path)),false);}finally{f.close();}
 }
});

test('a package requires admission, then a second explicit same-button click with live browser activation',async()=>{
 const f=await fixture();
 try{
  await f.open();const button=f.d.getElementById('packageList').firstElementChild;
  assert.match(button.textContent,/5,00.*5,49/);const chosen=await f.choose();assert.equal(chosen,button);assert.equal(f.paymentRequests.length,0);
  const creation=f.calls.find(x=>x.path.endsWith('/intents')),body=JSON.parse(creation.options.body);assert.deepEqual(Object.keys(body).sort(),['productId','requestId']);assert.equal(body.productId,'rig_credit_5');
  assert.equal(f.d.getElementById('packageList').children[1].disabled,true);
  f.click(button);assert.equal(f.paymentRequests.length,1);assert.equal(f.paymentRequests[0].synchronousGesture,true);
  assert.deepEqual(f.paymentRequests[0].methods,[{supportedMethods:'https://play.google.com/billing',data:{sku:'rig_credit_5',obfuscatedAccountId:ACCOUNT}}]);
  assert.deepEqual(f.paymentRequests[0].paymentDetails.total.amount,{value:'5.49',currency:'EUR'});
  await settle(()=>f.completions.length===1);
  const confirmation=JSON.parse(f.calls.find(x=>x.path.endsWith('/confirm')).options.body);
  assert.deepEqual(confirmation,{intentId:body.requestId,productId:'rig_credit_5',purchaseToken:'google-purchase-token-fixture'});
  assert.equal(f.storeCalls.some(x=>x[0]==='CLIENT_CONSUME'),false);assert.deepEqual(f.serverConsumed,['google-purchase-token-fixture']);assert.match(f.d.getElementById('creditsButton').textContent,/10,00/);assert.equal(f.values.has(KEY),false);assert.deepEqual(f.completions,['success']);
 }finally{f.close();}
});

test('a delayed admission cannot duplicate requests or open a Google sheet before its reply',async()=>{
 const gate=deferred(),f=await fixture({admit:(body,api)=>{api.setIntent(prepared({intentId:body.requestId}));return gate.promise;}});
 try{
  await f.open();const button=f.d.getElementById('packageList').firstElementChild;f.click(button);button.dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));
  await settle(()=>f.calls.some(x=>x.path.endsWith('/intents')));assert.equal(button.disabled,true);assert.equal(f.d.getElementById('creditsButton').disabled,true);assert.equal(f.calls.filter(x=>x.path.endsWith('/intents')).length,1);assert.equal(f.paymentRequests.length,0);
  gate.resolve(Response.json(f.getIntent()));await settle(()=>button.textContent.startsWith('Betaal ')&&!button.disabled);assert.equal(f.paymentRequests.length,0);
 }finally{f.close();}
});

test('the admission UUID is retained and recovered when its successful server reply is lost',async()=>{
 const f=await fixture({admit:(body,api)=>{api.setIntent(prepared({intentId:body.requestId}));throw TypeError('Connection lost after admission');}});
 try{
  await f.open();f.click(f.d.getElementById('packageList').firstElementChild);await settle(()=>f.d.getElementById('packageList').firstElementChild?.textContent.startsWith('Betaal '));
  assert.equal(f.calls.filter(x=>x.path.endsWith('/intents')).length,1);assert.equal(f.paymentRequests.length,0);
  const saved=JSON.parse(f.values.get(KEY));assert.equal(saved.intentId,JSON.parse(f.calls.find(x=>x.path.endsWith('/intents')).options.body).requestId);
  assert.ok(f.calls.some(x=>x.path.endsWith('/status?intentId='+saved.intentId)));assert.deepEqual(Object.keys(saved).sort(),['intentId','requestId']);
 }finally{f.close();}
});

test('no admission or payment occurs when safe per-account metadata storage is unavailable',async()=>{
 const f=await fixture({storageFailure:true});
 try{await f.open();f.click(f.d.getElementById('packageList').firstElementChild);await settle(()=>!f.d.getElementById('creditsButton').disabled);assert.equal(f.calls.some(x=>x.path.endsWith('/intents')),false);assert.equal(f.paymentRequests.length,0);}finally{f.close();}
});

for(const state of ['pending','refund_pending','refunded','review'])test(`server ${state} outcome never fabricates client credit or consumes a token`,async()=>{
 const f=await fixture({confirm:(body,api)=>{const row=api.getIntent(body.intentId);Object.assign(row,{state,consumed:false,recoveryPending:state!=='refunded',newPurchasesBlocked:state!=='refunded',refundPending:state==='refund_pending'});return Response.json({...row});}});
 try{
  await f.open();const button=await f.choose();f.click(button);await settle(()=>f.completions.length===1);
  assert.equal(f.balance(),500);assert.match(f.d.getElementById('creditsButton').textContent,/5,00/);assert.equal(f.storeCalls.some(x=>x[0]==='CLIENT_CONSUME'),false);assert.deepEqual(f.completions,['unknown']);
  assert.match(f.d.getElementById('creditsMessage').textContent,state.startsWith('refund')?/terugbetaald|terugbetaling/:/gecontroleerd|nagekeken/);
  if(state!=='refunded')assert.equal(f.d.getElementById('packageList').children.length,0);
 }finally{f.close();}
});

test('confirmed credit stays visible when server consumption still needs a retry',async()=>{
 const f=await fixture({confirm:(body,api)=>api.credits(body,{consumed:false})});
 try{
  await f.open();f.click(await f.choose());await settle(()=>f.completions.length===1);assert.match(f.d.getElementById('creditsButton').textContent,/10,00/);assert.match(f.d.getElementById('creditsMessage').textContent,/tegoed is bijgeschreven.*afgehandeld/);assert.equal(f.d.getElementById('packageList').children.length,0);assert.equal(f.values.has(KEY),true);assert.equal(f.storeCalls.some(x=>x[0]==='CLIENT_CONSUME'),false);
  Object.assign(f.getIntent(),{consumed:true,recoveryPending:false,newPurchasesBlocked:false});await f.open();assert.equal(f.values.has(KEY),false);assert.equal(f.d.getElementById('packageList').children.length,2);
 }finally{f.close();}
});

test('refund status is recovered durably and only terminal server acknowledgement permits another purchase',async()=>{
 const row=prepared({state:'refund_pending',recoveryPending:true,newPurchasesBlocked:true,refundPending:true}),f=await fixture({initialIntent:row,initialSlot:{intentId:ID,requestId:ID}});
 try{
  assert.equal(f.d.getElementById('creditsDialog').open,false,'startup recovery uses no extra popup');assert.equal(f.values.has(KEY),true);
  await f.open();assert.equal(f.d.getElementById('packageList').children.length,0);assert.match(f.d.getElementById('creditsMessage').textContent,/terugbetaling wordt verwerkt/);
  Object.assign(f.getIntent(),{state:'refunded',recoveryPending:false,newPurchasesBlocked:false,refundPending:false});await f.open();assert.match(f.d.getElementById('creditsMessage').textContent,/betaling is terugbetaald/);assert.equal(f.values.has(KEY),false);assert.equal(f.d.getElementById('packageList').children.length,2);assert.equal(f.paymentRequests.length,0);
 }finally{f.close();}
});

test('recovery cannot mint an admission for an unassociated store token',async()=>{
 const f=await fixture({purchases:[{itemId:'rig_credit_5',purchaseToken:'unassociated-google-token'}]});
 try{await f.open();assert.equal(f.calls.some(x=>x.path.endsWith('/intents')||x.path.endsWith('/confirm')),false);assert.equal(f.paymentRequests.length,0);assert.equal(f.d.getElementById('packageList').children.length,0);assert.match(f.d.getElementById('creditsMessage').textContent,/Koop niet opnieuw/);}finally{f.close();}
});

test('saved IDs recover real store receipts while new sales are paused',async()=>{
 const f=await fixture({config:{...configured,enabled:false,recoveryReady:true},initialIntent:prepared(),initialSlot:{intentId:ID,requestId:ID},purchases:[{itemId:'rig_credit_5',purchaseToken:'previous-real-google-token'}]});
 try{assert.equal(f.d.getElementById('creditsDialog').open,false);assert.equal(f.paymentRequests.length,0);assert.equal(f.calls.filter(x=>x.path.endsWith('/confirm')).length,1);assert.match(f.d.getElementById('creditsButton').textContent,/10,00/);assert.equal(f.values.has(KEY),false);assert.equal(f.storeCalls.some(x=>x[0]==='CLIENT_CONSUME'),false);await f.open();assert.equal(f.d.getElementById('packageList').children.length,0);}finally{f.close();}
});

test('duplicate paid receipts preserve credited balance while an extra refund remains unresolved',async()=>{
 let count=0;
 const f=await fixture({initialIntent:prepared(),purchases:[{itemId:'rig_credit_5',purchaseToken:'first-real-google-token'},{itemId:'rig_credit_5',purchaseToken:'second-real-google-token'}],confirm:(body,api)=>{
  if(++count===1)return api.credits(body);
  Object.assign(api.getIntent(body.intentId),{state:'credited',consumed:true,recoveryPending:true,newPurchasesBlocked:true,refundPending:true});return Response.json({state:'refund_pending'});
 }});
 try{await f.open();assert.match(f.d.getElementById('creditsButton').textContent,/10,00/);assert.match(f.d.getElementById('creditsMessage').textContent,/tegoed is bijgeschreven.*extra betaling wordt terugbetaald/);assert.equal(f.d.getElementById('packageList').children.length,0);assert.equal(f.values.has(KEY),true);assert.equal(f.paymentRequests.length,0);}finally{f.close();}
});

test('account changes during admission discard its reply before a payment can be offered',async()=>{
 const gate=deferred(),f=await fixture({admit:(body,api)=>{api.setIntent(prepared({intentId:body.requestId}));return gate.promise;}});
 try{await f.open();f.click(f.d.getElementById('packageList').firstElementChild);await settle(()=>f.calls.some(x=>x.path.endsWith('/intents')));f.deactivate();gate.resolve(Response.json(f.getIntent()));await new Promise(r=>setTimeout(r,10));assert.equal(f.paymentRequests.length,0);assert.equal(f.calls.some(x=>x.path.endsWith('/confirm')),false);}finally{f.close();}
});

test('account changes while Google is open discard the raw token and never persist it',async()=>{
 const gate=deferred(),f=await fixture({show:()=>gate.promise});
 try{await f.open();f.click(await f.choose());assert.equal(f.paymentRequests.length,1);f.deactivate();gate.resolve(f.response);await settle(()=>f.completions.length===1);assert.equal(f.calls.some(x=>x.path.endsWith('/confirm')),false);assert.equal([...f.values.values()].some(value=>value.includes('google-purchase-token')),false);assert.equal(f.storeCalls.some(x=>x[0]==='CLIENT_CONSUME'),false);}finally{f.close();}
});

test('an old-account confirmation cannot refresh another account or consume in the client',async()=>{
 const gate=deferred(),f=await fixture({confirm:()=>gate.promise});
 try{await f.open();f.click(await f.choose());await settle(()=>f.calls.some(x=>x.path.endsWith('/confirm')));const reads=f.calls.filter(x=>x.path==='/api/payments/balance').length;f.deactivate();gate.resolve(Response.json({state:'credited',creditsCents:500,consumed:true}));await settle(()=>f.completions.length===1);assert.equal(f.calls.filter(x=>x.path==='/api/payments/balance').length,reads);assert.equal(f.storeCalls.some(x=>x[0]==='CLIENT_CONSUME'),false);}finally{f.close();}
});

test('a cancelled Google sheet reuses the same still-valid owned admission without another UUID',async()=>{
 const f=await fixture({show:()=>Promise.reject(new DOMException('Canceled','AbortError'))});
 try{
  await f.open();const button=await f.choose();f.click(button);await settle(()=>f.d.getElementById('creditsMessage').textContent.includes('geannuleerd'));assert.equal(f.calls.filter(x=>x.path.endsWith('/intents')).length,1);
  f.click(button);await settle(()=>f.paymentRequests.length===2);assert.equal(f.calls.filter(x=>x.path.endsWith('/intents')).length,1);assert.equal(f.calls.some(x=>x.path.endsWith('/confirm')),false);
 }finally{f.close();}
});

test('initial page events preserve the prepared button while real resume recovers the same admission without charging',async()=>{
 const f=await fixture();
 try{
  await f.open();const button=await f.choose(),id=f.getIntent().intentId,reads=f.calls.filter(x=>x.path.endsWith('/config')).length;
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pageshow',{persisted:false}));f.w.dispatchEvent(new f.w.Event('focus'));await new Promise(r=>setTimeout(r,0));
  assert.equal(button.isConnected,true);assert.equal(f.calls.filter(x=>x.path.endsWith('/config')).length,reads);assert.equal(f.paymentRequests.length,0);
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pageshow',{persisted:true}));await settle(()=>f.calls.filter(x=>x.path.endsWith('/config')).length>reads);await settle(()=>!f.d.getElementById('creditsButton').disabled);
  assert.equal(f.getIntent().intentId,id);assert.match(f.d.getElementById('packageList').firstElementChild.textContent,/^Betaal /);assert.equal(f.calls.filter(x=>x.path.endsWith('/intents')).length,1);assert.equal(f.paymentRequests.length,0);
 }finally{f.close();}
});

test('expired admissions cannot open a store sheet or silently create another one',async()=>{
 const f=await fixture({initialIntent:prepared({expiresAt:Date.now()-1})});
 try{await f.open();const button=f.d.getElementById('packageList').firstElementChild;assert.equal(button.disabled,true);button.dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));assert.equal(f.paymentRequests.length,0);assert.equal(f.calls.some(x=>x.path.endsWith('/intents')),false);assert.match(f.d.getElementById('creditsMessage').textContent,/verlopen/);
  Object.assign(f.getIntent(),{state:'expired',newPurchasesBlocked:false});await f.open();assert.equal(f.values.has(KEY),false);assert.equal(f.d.getElementById('packageList').firstElementChild.disabled,false);
 }finally{f.close();}
});

test('unsupported currency, malformed identity/catalogue and mode mismatches never prepare or charge',async()=>{
 for(const options of [
  {catalog:[{itemId:'rig_credit_5',price:{currency:'USD',value:'5.49'}}]},
  {catalog:[{itemId:'rig_credit_5',price:{currency:'EUR',value:'5.50'}}]},
  {catalog:[{itemId:'rig_credit_5',price:{currency:'EUR',value:'5.490000001'}}]},
  {config:{...configured,accountId:'alice@example.test'}},
  {config:{...configured,products:[configured.products[0],configured.products[0]]}},
  {config:{...configured,mode:'test'}}
 ]){
  const f=await fixture(options);try{await f.open();assert.equal(f.d.getElementById('packageList').children.length,0);assert.equal(f.calls.some(x=>x.path.endsWith('/intents')),false);assert.equal(f.paymentRequests.length,0);}finally{f.close();}
 }
});

test('a credited response still cannot increase the UI balance without the server ledger showing it',async()=>{
 const f=await fixture({confirm:(body,api)=>{Object.assign(api.getIntent(body.intentId),{state:'credited',consumed:true,recoveryPending:false,newPurchasesBlocked:false});return Response.json({state:'credited',creditsCents:500,consumed:true});}});
 try{await f.open();f.click(await f.choose());await settle(()=>f.completions.length===1);assert.match(f.d.getElementById('creditsButton').textContent,/5,00/);assert.equal(f.balance(),500);assert.equal(f.storeCalls.some(x=>x[0]==='CLIENT_CONSUME'),false);}finally{f.close();}
});

for(const reply of [{state:'credited',creditsCents:5000,consumed:true},{state:'credited',creditsCents:500}])test('malformed credit acknowledgement stays unresolved rather than granting or consuming locally',async()=>{
 const f=await fixture({confirm:()=>Response.json(reply)});
 try{await f.open();f.click(await f.choose());await settle(()=>f.completions.length===1);assert.equal(f.balance(),500);assert.equal(f.d.getElementById('packageList').children.length,0);assert.match(f.d.getElementById('creditsMessage').textContent,/Koop niet opnieuw/);assert.equal(f.storeCalls.some(x=>x[0]==='CLIENT_CONSUME'),false);}finally{f.close();}
});

test('test configuration never promises a free Google transaction based on that flag alone',async()=>{
 const f=await fixture({config:{...configured,mode:'test'},mode:'test'});
 try{await f.open();assert.match(f.d.getElementById('creditsButton').textContent,/RIG-testtegoed/);assert.doesNotMatch(f.d.getElementById('creditsMessage').textContent,/gratis|geen echt geld/i);assert.equal(f.paymentRequests.length,0);}finally{f.close();}
});

test('a frozen balance blocks new charges while existing receipts can still be resolved by the server',async()=>{
 const f=await fixture({frozen:true,initialIntent:prepared(),purchases:[{itemId:'rig_credit_5',purchaseToken:'frozen-account-google-token'}]});
 try{await f.open();assert.equal(f.calls.filter(x=>x.path.endsWith('/confirm')).length,1);assert.equal(f.paymentRequests.length,0);for(const button of f.d.getElementById('packageList').children)assert.equal(button.disabled,true);}finally{f.close();}
});

test('unknown listing and confirmation results keep all offers locked until recovery finishes',async()=>{
 const listing=deferred(),confirmation=deferred(),f=await fixture({initialIntent:prepared(),purchases:()=>listing.promise,confirm:()=>confirmation.promise});
 try{
  const opening=f.app.openCredits();await settle(()=>f.storeCalls.some(x=>x[0]==='listPurchases'));
  assert.equal(f.d.getElementById('creditsButton').disabled,true);assert.equal(f.d.getElementById('refreshPayment').disabled,true);assert.equal(f.d.getElementById('packageList').children.length,0);
  await f.app.openCredits();assert.equal(f.storeCalls.filter(x=>x[0]==='listPurchases').length,1);
  listing.resolve([{itemId:'rig_credit_5',purchaseToken:'unresolved-real-google-token'}]);await settle(()=>f.calls.some(x=>x.path.endsWith('/confirm')));assert.equal(f.d.getElementById('creditsButton').disabled,true);assert.equal(f.paymentRequests.length,0);
  Object.assign(f.getIntent(),{state:'pending',recoveryPending:true,newPurchasesBlocked:true});confirmation.resolve(Response.json({state:'pending'}));await opening;
  assert.equal(f.d.getElementById('packageList').children.length,0);assert.equal(f.paymentRequests.length,0);assert.equal(f.d.getElementById('creditsButton').disabled,false);
 }finally{f.close();}
});

test('client metadata cannot supply an account, purchase token, product or credit amount',async()=>{
 const f=await fixture();
 try{f.values.set(KEY,JSON.stringify({intentId:ID,requestId:ID,purchaseToken:'forged-purchase',creditsCents:50000,accountId:ACCOUNT}));await f.open();assert.equal(f.values.has(KEY),false);assert.equal(f.calls.some(x=>x.path.endsWith('/confirm')||x.path.endsWith('/intents')),false);assert.equal(f.balance(),500);}finally{f.close();}
});
