import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {publicCommerce} from './commerce-profile.mjs';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8'),script=readFileSync(new URL('./frontend/multiuser/payments.js',import.meta.url),'utf8');
const orderId='a65ca7a2-389d-42bb-92bb-e02024ea8c3a',ticketId='3c3f0e65-af97-4025-9ae0-4472c30bd129';
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not settle');};
async function setup({orders=[],required=true,deferredOrders}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,calls=[],redirects=[],downloads=[],revoked=[],storage=new Map();let active=true;
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 w.rigNativeSite=true;w.rigVideoFunding='credits';w.rigSessionActive=()=>active;w.rigScopedStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};w.rigCheckout=async u=>redirects.push(u);
 w.URL.createObjectURL=()=>{const url='blob:owned-'+downloads.length;downloads.push(url);return url;};w.URL.revokeObjectURL=u=>revoked.push(u);w.HTMLAnchorElement.prototype.click=function(){};
 const details={mode:'live',currency:'EUR',purchasesEnabled:true,frozen:false};
 w.rigRequest=async(path,init={})=>{
  calls.push([path,init]);
  if(path==='/api/payments/balance')return Response.json({...details,balance:500});
  if(path==='/api/payments/packages')return Response.json({...details,packages:[{id:'credits-5',amountCents:500,credits:500}],...(required?{commerce:{...publicCommerce(),required:true}}:{})});
  if(path==='/api/payments/orders')return deferredOrders?deferredOrders():Response.json({orders});
  if(path.endsWith('/reconcile'))return Response.json({state:'paid'});
  if(path.endsWith('/receipt')||path.endsWith('/confirmation'))return new Response('<html>Owned receipt</html>',{headers:{'content-type':'text/html'}});
  if(path==='/api/payments/create')return Response.json({checkoutUrl:'https://www.mollie.com/checkout/live-fixture'});
  if(path==='/api/payments/support-requests')return init.method==='POST'?Response.json({id:ticketId,monetaryActionPerformed:false}):Response.json({requests:[]});
  throw Error('Unexpected '+path);
 };
 w.eval(script);await wait(()=>calls.length&&d.getElementById('creditsButton').textContent.includes('5,00'));d.getElementById('creditsButton').click();await wait(()=>d.getElementById('packageList').children.length&&calls.some(([p])=>p==='/api/payments/orders'));
 const history=async()=>{const el=d.getElementById('customerHistory');el.open=true;el.dispatchEvent(new w.Event('toggle'));await wait(()=>d.getElementById('customerHelpMessage')||el.textContent.includes('nog geen aankopen'));return el;};
 return {dom,w,d,calls,redirects,downloads,revoked,history,stop:()=>{active=false;w.rigPaymentsDispose();},close:()=>dom.window.close()};
}
test('commercial purchase needs a country and explicit unchecked terms before any Mollie request',async()=>{
 const f=await setup();try{
  const button=f.d.querySelector('.package-button'),country=f.d.getElementById('buyerCountry'),consent=f.d.getElementById('acceptCommerce');assert.equal(button.disabled,true);assert.equal(consent.checked,false);button.click();assert.equal(f.calls.some(([p])=>p==='/api/payments/create'),false);
  consent.checked=true;consent.dispatchEvent(new f.w.Event('change'));assert.equal(button.disabled,true);country.value='NL';country.dispatchEvent(new f.w.Event('change'));await wait(()=>!button.disabled);button.click();await wait(()=>f.redirects.length===1);
  const payload=JSON.parse(f.calls.find(([p])=>p==='/api/payments/create')[1].body);assert.deepEqual(payload.commerce,{version:publicCommerce().version,country:'NL',customerType:'consumer',accepted:true});assert.equal(payload.packageId,'credits-5');assert.match(payload.requestId,/^[a-f0-9-]{36}$/);
  assert.equal(f.d.querySelector('#commerceChoice a').getAttribute('href'),'/voorwaarden');assert.equal(f.calls.some(([p])=>/owner|fal/.test(p)),false);
 }finally{f.close();}
});
test('legacy test checkout remains compatible while consent never survives reopening',async()=>{
 const old=await setup({required:false});try{await wait(()=>old.d.querySelector('.package-button').disabled===false);assert.equal(old.d.getElementById('commerceChoice'),null);}finally{old.close();}
 const f=await setup();try{f.d.getElementById('buyerCountry').value='NL';f.d.getElementById('buyerCountry').dispatchEvent(new f.w.Event('change'));f.d.getElementById('acceptCommerce').checked=true;f.d.getElementById('acceptCommerce').dispatchEvent(new f.w.Event('change'));f.d.getElementById('closeCredits').click();f.d.getElementById('creditsButton').click();await wait(()=>f.d.getElementById('acceptCommerce'));assert.equal(f.d.getElementById('acceptCommerce').checked,false);assert.equal(f.d.getElementById('buyerCountry').value,'');}finally{f.close();}
});
test('customer receipts and support are lazy and use the bound account without public token URLs',async()=>{
 const f=await setup({orders:[{requestId:orderId,amountCents:500,credits:500,state:'paid'}]});try{
  assert.equal(f.calls.some(([p])=>p==='/api/payments/support-requests'),false);const history=await f.history();assert.equal(history.querySelectorAll('form').length,0);assert.match(history.textContent,/Betaald/);
  [...history.querySelectorAll('button')].find(x=>x.textContent==='Betalingsbewijs downloaden').click();await wait(()=>f.downloads.length===1);assert.ok(f.calls.some(([p])=>p===`/api/payments/orders/${orderId}/receipt`));assert.equal(f.calls.some(([p])=>p.includes('token=')),false);
  f.stop();assert.deepEqual(f.revoked,f.downloads);assert.equal(f.d.getElementById('customerHistory'),null);assert.equal(f.d.getElementById('creditsDialog').open,false);assert.equal(f.d.getElementById('packageList').children.length,0);
 }finally{f.close();}
});
test('withdrawal creates a customer request and downloadable confirmation without a refund call',async()=>{
 const f=await setup({orders:[{requestId:orderId,amountCents:500,credits:500,state:'paid'}]});try{
  const history=await f.history(),kind=history.querySelector('[aria-label="Soort verzoek"]');kind.value='withdrawal';history.querySelector('textarea').value='Ik wil mijn aankoop herroepen.';[...history.querySelectorAll('button')].find(x=>x.textContent==='Verzoek indienen').click();await wait(()=>f.d.getElementById('customerHelpMessage').textContent.includes('ontvangen'));
  const post=f.calls.filter(([p,i])=>p==='/api/payments/support-requests'&&i.method==='POST');assert.equal(post.length,1);const value=JSON.parse(post[0][1].body);assert.equal(value.kind,'withdrawal');assert.equal(value.orderRequestId,orderId);assert.match(value.idempotencyKey,/^[a-f0-9-]{36}$/);
  [...history.querySelectorAll('button')].find(x=>x.textContent==='Ontvangstbevestiging downloaden').click();await wait(()=>f.downloads.length===1);assert.ok(f.calls.some(([p])=>p===`/api/payments/support-requests/${ticketId}/confirmation`));assert.equal(f.calls.some(([p])=>/refund|owner|generations/.test(p)),false);
 }finally{f.close();}
});
test('an account change discards a late history response and disables all purchase data',async()=>{
 let resolve,blocks=false;const pending=new Promise(r=>resolve=r);const f=await setup({deferredOrders:()=>blocks?pending:Response.json({orders:[]})});try{
  blocks=true;const history=f.d.getElementById('customerHistory');history.open=true;history.dispatchEvent(new f.w.Event('toggle'));await wait(()=>history.textContent.includes('ophalen'));f.stop();resolve(Response.json({orders:[{requestId:orderId,amountCents:500,state:'paid'}]}));await new Promise(r=>setTimeout(r,20));assert.equal(f.d.getElementById('customerHistory'),null);assert.doesNotMatch(f.d.body.textContent,new RegExp(orderId));assert.equal(f.redirects.length,0);
 }finally{f.close();}
});
