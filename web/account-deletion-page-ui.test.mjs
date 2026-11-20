import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {commerceDocument} from './commerce-documents.mjs';
import {mountAccountDeletionPage,validDeletionReceipt} from './frontend/multiuser/account-deletion-page.mjs';

const USER='u-11111111-1111-4111-8111-111111111111',OTHER='u-22222222-2222-4222-8222-222222222222';
const ID='33333333-3333-4333-8333-333333333333',REQUEST='44444444-4444-4444-8444-444444444444';
const receipt=(change={})=>({id:ID,type:'account-deletion',status:'pending',createdAt:Date.parse('2026-11-20T13:00:00Z'),replayed:false,acknowledgement:'Je verzoek is ontvangen.',actionPerformed:false,...change});
const pause=()=>new Promise(resolve=>setTimeout(resolve,1));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function waitFor(check){for(let i=0;i<500;i++){if(check())return;await pause();}assert.fail('Timed out waiting for deletion UI');}
async function fixture({user=USER,requests=[],get,post}={}){
 const dom=new JSDOM(await commerceDocument('/account/verwijderen').text(),{url:'https://rig.test/account/verwijderen',runScripts:'outside-only'}),win=dom.window,d=win.document,calls=[];
 let currentUser=user;
 win.crypto.randomUUID=()=>REQUEST;
 win.fetch=async(url,options={})=>{
  const target=new URL(url);assert.equal(target.origin,'https://rig.test');calls.push({path:target.pathname,options});
  assert.equal(options.credentials,'same-origin');assert.equal(options.mode,'same-origin');assert.equal(options.redirect,'error');
  if(target.pathname==='/api/session')return currentUser?Response.json({userId:currentUser}):Response.json({error:'Meld je aan.'},{status:401});
  assert.equal(new Headers(options.headers).get('x-rig-expected-user'),USER);
  if(target.pathname==='/api/account-deletion-requests'){
   if(options.method==='POST')return post?post(options,{setUser(value){currentUser=value;}}):Response.json(receipt(),{status:201});
   return get?get(options,{setUser(value){currentUser=value;}}):Response.json({requests,limit:20});
  }
  assert.fail('Unexpected route '+target.pathname);
 };
 const mounted=await mountAccountDeletionPage({browser:win});
 return {dom,win,d,calls,close(){mounted.dispose();win.close();},setUser(value){currentUser=value;},setRequests(value){requests=value;}};
}
function submit(f){f.d.getElementById('deletionForm').dispatchEvent(new f.win.Event('submit',{bubbles:true,cancelable:true}));}
function consent(f){f.d.getElementById('deletionConfirm').click();}
const posts=f=>f.calls.filter(call=>call.options.method==='POST');
const checks=f=>f.calls.filter(call=>call.path==='/api/account-deletion-requests'&&call.options.method==='GET');
const refresh=f=>f.d.getElementById('deletionCheck');

test('public resource remains informational for anonymous visitors and sends no request',async()=>{
 const f=await fixture({user:null});try{
  assert.equal(f.d.getElementById('deletionForm').hidden,true);assert.equal(f.d.getElementById('deletionLogin').hidden,false);
  assert.equal(f.d.getElementById('deletionSubmit').disabled,true);assert.match(f.d.getElementById('deletionStatus').textContent,/Meld je aan/);
  submit(f);await pause();assert.equal(posts(f).length,0);assert.equal(f.calls.every(call=>call.path==='/api/session'),true);
 }finally{f.close();}
});

test('own account must explicitly consent and receives a real pending receipt without logout or deletion',async()=>{
 const f=await fixture();try{
  assert.equal(f.d.getElementById('deletionForm').hidden,false);assert.equal(f.d.getElementById('deletionSubmit').disabled,true);
  submit(f);await pause();assert.equal(posts(f).length,0);consent(f);assert.equal(f.d.getElementById('deletionSubmit').disabled,false);submit(f);
  await waitFor(()=>f.d.getElementById('deletionReceipt').textContent.includes(ID));
  assert.equal(posts(f).length,1);assert.deepEqual(JSON.parse(posts(f)[0].options.body),{requestId:REQUEST});
  assert.equal(new Headers(posts(f)[0].options.headers).get('x-rig-expected-user'),USER);
  assert.match(f.d.getElementById('deletionReceipt').textContent,/account is nog niet verwijderd/);
  assert.match(f.d.getElementById('deletionReceipt').textContent,/20 nov/);assert.equal(f.d.getElementById('deletionSubmit').disabled,true);
  assert.equal(f.calls.some(call=>/auth\/logout|generations|payments|assets/.test(call.path)),false);
 }finally{f.close();}
});

test('existing pending requests are restored after reopening without another POST',async()=>{
 const f=await fixture({requests:[receipt()]});try{
  assert.match(f.d.getElementById('deletionReceipt').textContent,new RegExp(ID));assert.equal(f.d.getElementById('deletionSubmit').disabled,true);
  consent(f);submit(f);await pause();assert.equal(posts(f).length,0);
 }finally{f.close();}
});

test('a lost POST response preserves the exact request ID for a deliberate retry',async()=>{
 let attempts=0;
 const f=await fixture({post(){if(++attempts===1)throw Error('Connection lost');return Response.json(receipt({replayed:true}),{status:200});}});try{
  consent(f);submit(f);await waitFor(()=>f.d.getElementById('deletionStatus').dataset.error==='true');assert.equal(posts(f).length,1);
  assert.equal(f.d.getElementById('deletionSubmit').disabled,false);submit(f);await waitFor(()=>f.d.getElementById('deletionReceipt').textContent.includes(ID));
  assert.deepEqual(posts(f).map(call=>JSON.parse(call.options.body).requestId),[REQUEST,REQUEST]);
 }finally{f.close();}
});

test('checking after an uncertain submission restores its server receipt without another POST',async()=>{
 const f=await fixture({post(){f.setRequests([receipt({replayed:true})]);throw Error('Connection lost after recording');}});try{
  consent(f);submit(f);await waitFor(()=>f.d.getElementById('deletionStatus').dataset.error==='true');assert.equal(posts(f).length,1);
  refresh(f).click();await waitFor(()=>f.d.getElementById('deletionReceipt').textContent.includes(ID));assert.equal(checks(f).length,2);assert.equal(posts(f).length,1);assert.equal(f.d.getElementById('deletionSubmit').disabled,true);
  submit(f);await pause();assert.equal(posts(f).length,1);
 }finally{f.close();}
});

test('failed receipt checks preserve a confirmed request and allow an explicit read-only retry',async()=>{
 let attempts=0;const f=await fixture({get(){return ++attempts===2?Response.json({error:'Tijdelijk niet beschikbaar.'},{status:503}):Response.json({requests:[receipt()],limit:20});}});try{
  assert.match(f.d.getElementById('deletionReceipt').textContent,new RegExp(ID));refresh(f).click();await waitFor(()=>f.d.getElementById('deletionStatus').dataset.error==='true'&&!refresh(f).disabled);
  assert.match(f.d.getElementById('deletionReceipt').textContent,new RegExp(ID));assert.equal(f.d.getElementById('deletionSubmit').disabled,true);
  refresh(f).click();await waitFor(()=>checks(f).length===3&&!refresh(f).disabled&&f.d.getElementById('deletionStatus').dataset.error==='false');assert.equal(posts(f).length,0);
 }finally{f.close();}
});

test('receipt checks lock both controls and ignore repeated checks or submits until complete',async()=>{
 const pending=deferred();let attempts=0;const f=await fixture({get(){return ++attempts===1?Response.json({requests:[],limit:20}):pending.promise;}});try{
  consent(f);refresh(f).click();await waitFor(()=>checks(f).length===2);assert.equal(refresh(f).disabled,true);assert.equal(f.d.getElementById('deletionSubmit').disabled,true);assert.equal(f.d.getElementById('deletionConfirm').disabled,true);
  refresh(f).dispatchEvent(new f.win.Event('click'));submit(f);await pause();assert.equal(checks(f).length,2);assert.equal(posts(f).length,0);
  pending.resolve(Response.json({requests:[receipt()],limit:20}));await waitFor(()=>f.d.getElementById('deletionReceipt').textContent.includes(ID));assert.equal(refresh(f).disabled,false);assert.equal(f.d.getElementById('deletionSubmit').disabled,true);
 }finally{f.close();}
});

test('a temporary rate limit keeps the same submission ID and never reports a successful request',async()=>{
 let attempts=0;const f=await fixture({post:()=>++attempts===1?Response.json({error:'Te veel aanvragen.'},{status:429}):Response.json(receipt(),{status:201})});try{
  consent(f);submit(f);await waitFor(()=>f.d.getElementById('deletionStatus').dataset.error==='true');assert.match(f.d.getElementById('deletionStatus').textContent,/Probeer later opnieuw/);assert.equal(f.d.getElementById('deletionReceipt').textContent,'');
  submit(f);await waitFor(()=>f.d.getElementById('deletionReceipt').textContent.includes(ID));assert.deepEqual(posts(f).map(call=>JSON.parse(call.options.body).requestId),[REQUEST,REQUEST]);
 }finally{f.close();}
});

test('an account change before submit or during its response clears old-account receipt and prevents replay',async()=>{
 const f=await fixture();try{
  consent(f);f.setUser(OTHER);submit(f);await waitFor(()=>f.d.getElementById('deletionForm').hidden);
  assert.equal(posts(f).length,0);assert.equal(f.d.getElementById('deletionReceipt').textContent,'');assert.equal(f.d.getElementById('deletionLogin').hidden,false);
 }finally{f.close();}
 const late=await fixture({post(_options,control){control.setUser(OTHER);return Response.json(receipt(),{status:201});}});try{
  consent(late);submit(late);await waitFor(()=>late.d.getElementById('deletionForm').hidden);
  assert.equal(posts(late).length,1);assert.equal(late.d.getElementById('deletionReceipt').textContent,'');submit(late);await pause();assert.equal(posts(late).length,1);
 }finally{late.close();}
});

test('a verified account change clears an existing receipt and discards a delayed receipt body',async()=>{
 const existing=await fixture({requests:[receipt()]});try{
  assert.match(existing.d.getElementById('deletionReceipt').textContent,new RegExp(ID));existing.setUser(OTHER);existing.win.dispatchEvent(new existing.win.Event('focus'));await waitFor(()=>existing.d.getElementById('deletionForm').hidden);assert.equal(existing.d.getElementById('deletionReceipt').textContent,'');assert.equal(refresh(existing).disabled,true);assert.equal(posts(existing).length,0);
 }finally{existing.close();}
 let release,reading=false;const body=new ReadableStream({pull(controller){reading=true;release=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(receipt())));controller.close();};}},{highWaterMark:0});
 const late=await fixture({post:()=>new Response(body,{status:201,headers:{'content-type':'application/json'}})});try{
  consent(late);submit(late);await waitFor(()=>reading);late.setUser(OTHER);late.win.dispatchEvent(new late.win.Event('focus'));await waitFor(()=>late.d.getElementById('deletionForm').hidden);release();await pause();assert.equal(late.d.getElementById('deletionReceipt').textContent,'');submit(late);await pause();assert.equal(posts(late).length,1);
 }finally{late.close();}
});

test('malformed history never renders a partial receipt and remains available for an explicit retry',async()=>{
 for(const data of [{requests:[receipt()],limit:19},{requests:Array.from({length:21},()=>receipt()),limit:20},{requests:[receipt(),receipt({actionPerformed:true})],limit:20},{requests:'invalid',limit:20}]){
  let valid=false;const f=await fixture({get:()=>Response.json(valid?{requests:[receipt()],limit:20}:data)});try{
   assert.equal(f.d.getElementById('deletionStatus').dataset.error,'true');assert.equal(f.d.getElementById('deletionReceipt').textContent,'');assert.equal(refresh(f).disabled,false);valid=true;refresh(f).click();await waitFor(()=>f.d.getElementById('deletionReceipt').textContent.includes(ID));assert.equal(posts(f).length,0);
  }finally{f.close();}
 }
});

test('untrusted acknowledgement is text only and malformed or oversized replies never become success',async()=>{
 const attack='<img src=x onerror=steal()>';
 const f=await fixture({post:()=>Response.json(receipt({acknowledgement:attack}),{status:201})});try{
  consent(f);submit(f);await waitFor(()=>f.d.getElementById('deletionReceipt').textContent.includes(attack));assert.equal(f.d.querySelectorAll('#deletionReceipt img, #deletionReceipt script').length,0);
 }finally{f.close();}
 for(const payload of [receipt({actionPerformed:true}),receipt({id:'bad'}),receipt({acknowledgement:'x'.repeat(20_000)})]){
  const invalid=await fixture({post:()=>Response.json(payload,{status:201})});try{
   consent(invalid);submit(invalid);await waitFor(()=>invalid.d.getElementById('deletionStatus').dataset.error==='true');assert.equal(invalid.d.getElementById('deletionReceipt').textContent,'');
  }finally{invalid.close();}
 }
 assert.equal(validDeletionReceipt(receipt({jobId:ID})),false);assert.equal(validDeletionReceipt(receipt({createdAt:-1})),false);
});
