import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {isMollieCheckoutURL} from './mollie-checkout-url.mjs';
const html=await readFile('frontend/multiuser/index.html','utf8'),script=await readFile('frontend/multiuser/payments.js','utf8');
const standaloneScript=await readFile('frontend/payments.js','utf8');
const waitFor=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not settle')};
async function screen(checkoutUrl){
 const dom=new JSDOM(html,{url:'https://rig.local/',runScripts:'outside-only'}),w=dom.window,values=new Map();let redirected=null;
 for(const dialog of w.document.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false};}
 w.rigScopedStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 w.rigCheckout=url=>{redirected=url};
 w.rigRequest=async(path)=>Response.json(path==='/api/payments/packages'?{packages:[{id:'test-5',credits:500,amountCents:500}]}:path==='/api/payments/orders'?{orders:[]}:path==='/api/payments/create'?{checkoutUrl}:{balance:0});
 w.eval(script);w.document.getElementById('creditsButton').click();
 await waitFor(()=>w.document.getElementById('packageList').children.length===1&&!w.document.getElementById('packageList').children[0].disabled);
 w.document.getElementById('packageList').children[0].click();
 return {dom,w,redirected:()=>redirected};
}
test('Mollie checkout opens only after validated URL; foreign URL is refused',async()=>{
 const good=await screen('https://www.mollie.com/checkout/test-fixture');await waitFor(()=>good.redirected()!==null);
 assert.equal(good.redirected(),'https://www.mollie.com/checkout/test-fixture');
 assert.doesNotMatch(good.w.document.getElementById('creditsMessage').textContent,/betaling verwerkt/i);
 const bad=await screen('https://mollie.com.evil.invalid/checkout');await waitFor(()=>bad.w.document.getElementById('creditsMessage').textContent.includes('kon niet worden gecontroleerd'));
 assert.equal(bad.redirected(),null);good.dom.window.close();bad.dom.window.close();
});

const processorCheckout='https://redirect.ppro.com/v0/pages/?redirection_token=eyJhbGciOiJIUzI1NiJ9.eyJmaXh0dXJlIjp0cnVlfQ.c2lnbmF0dXJl';
async function checkoutScreen({multiuser,checkoutUrl,resume=false}){
 const dom=new JSDOM(html,{url:'https://rig.local/',runScripts:'outside-only'}),w=dom.window,d=w.document,values=new Map(),calls=[],redirects=[];
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false};}
 const request=async(path,init={})=>{
  calls.push([path,init]);const details={mode:'live',currency:'EUR',purchasesEnabled:true};
  return Response.json(path==='/api/payments/packages'?{...details,packages:[{id:'credits-25',credits:2500,amountCents:2500}]}:path==='/api/payments/orders'?{orders:resume?[{state:'open',requestId:'owned_request_123456'}]:[]}:path==='/api/payments/create'?{checkoutUrl}:path.endsWith('/reconcile')?{state:'open',checkoutUrl}:{...details,balance:0,frozen:false});
 };
 const browser={addEventListener:w.addEventListener.bind(w),setTimeout:w.setTimeout.bind(w),rigNativeSite:true,rigVideoFunding:'credits',rigVideoMode:'live',rigSessionActive:()=>true,rigScopedStorage:storage,rigRequest:request,rigCheckout:async url=>redirects.push(url)};
 const location={href:'https://rig.local/',assign:url=>redirects.push(url)};
 runInNewContext(multiuser?script:standaloneScript,{document:d,window:browser,sessionStorage:storage,fetch:request,location,URL,Intl,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'}});
 d.getElementById('creditsButton').click();
 await waitFor(()=>resume?d.getElementById('resumePayment').hidden===false:d.getElementById('packageList').firstElementChild?.disabled===false);
 return {dom,d,calls,values,redirects};
}

test('both browser payment flows resume the same verified PPRO Bancontact order without creating another payment',async()=>{
 for(const multiuser of [false,true]){
  const f=await checkoutScreen({multiuser,checkoutUrl:processorCheckout,resume:true});
  try{
   assert.equal(f.d.getElementById('resumePayment').hidden,false);assert.equal(f.redirects.length,0);
   assert.equal(f.values.get('rig-payment-request'),'owned_request_123456');assert.equal(f.d.getElementById('packageList').firstElementChild.disabled,true);
   assert.equal(f.calls.some(([path])=>path==='/api/payments/create'),false);
   f.d.getElementById('resumePayment').click();await waitFor(()=>f.redirects.length===1);assert.deepEqual(f.redirects,[processorCheckout]);
   assert.equal(f.calls.filter(([path])=>path.endsWith('/reconcile')).length,1);assert.equal(f.calls.some(([path])=>path==='/api/payments/create'),false);
  }finally{f.dom.window.close();}
 }
});

test('both classic payment guards agree with the shared policy and reject hostile checkout destinations',async()=>{
 const candidates=[
  ['https://mollie.com/checkout/fixture',true],['https://checkout.mollie.com/fixture?method=bancontact',true],[processorCheckout,true],
  [null,false],[17,false],[{},false],['//redirect.ppro.com/v0/pages/?redirection_token=a.b.c',false],
  [processorCheckout.replace('https:','http:'),false],[processorCheckout.replace('redirect.ppro.com','redirect.ppro.com.evil.invalid'),false],
  [processorCheckout.replace('redirect.ppro.com','another.ppro.com'),false],[processorCheckout.replace('/v0/pages/','/other/'),false],
  [processorCheckout.replace('redirect.ppro.com','user:password@redirect.ppro.com'),false],[processorCheckout.replace('redirect.ppro.com','redirect.ppro.com:8443'),false],
  [processorCheckout+'#token',false],[processorCheckout+'&redirect=https://evil.invalid',false],[processorCheckout+'&redirection_token=a.b.c',false],
  ['https://redirect.ppro.com/v0/pages/?redirection_token=',false],['https://redirect.ppro.com/v0/pages/?redirection_token=a..c',false],
  ['https://redirect.ppro.com/v0/pages/?redirection_token=a.b.c.d',false],['https://redirect.ppro.com/v0/pages/?redirection_token='+ 'a'.repeat(8190)+'.b.c',false],
  ['https://www.mollie.com.evil.invalid/checkout',false],['https://www.mollie.com/checkout#token',false],[' https://mollie.com/checkout',false],
  ['https://mollie.com/\ncheckout',false],['https://mollie.com/checkout?x='+ 'a'.repeat(16384),false],
 ];
 for(const [checkoutUrl,allowed] of candidates){
  assert.equal(isMollieCheckoutURL(checkoutUrl),allowed,'shared policy fixture');
  for(const multiuser of [false,true]){
   const f=await checkoutScreen({multiuser,checkoutUrl});
   try{
    f.d.getElementById('packageList').firstElementChild.click();
    await waitFor(()=>allowed?f.redirects.length===1:f.d.getElementById('creditsMessage').textContent.includes('kon niet worden gecontroleerd'));
    assert.equal(f.redirects.length,allowed?1:0,`${multiuser?'multiuser':'standalone'} destination policy`);
    assert.equal(f.calls.filter(([path])=>path==='/api/payments/create').length,1);
   }finally{f.dom.window.close();}
  }
 }
});
