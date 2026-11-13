import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('./frontend/multiuser/finance.js',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Finance UI did not settle');};
const summary=()=>({
 currency:'EUR',period:{month:null,from:null,to:null,timeZone:'Europe/Brussels'},
 income:{cashReceivedCents:2500,creditIssuedCents:2500,earnedVideoCents:175,refundedCents:0},
 credits:{outstandingCents:2325,promoIssuedCents:500,heldCents:0,negativeBalanceCents:0},
 costs:{estimatedFalCents:85,estimatedPaymentCents:18,estimatedPreparationCents:5,estimatedFailureReserveCents:9,estimatedTotalCents:117,actualRecordedCents:0,actualFalRecordedCents:0,actualMollieRecordedCents:0,fixedRecordedCents:0,falTopupsCents:0,actualCoverageComplete:false,actualProfitCents:null,recordedResultCents:175,missingActualJobs:1},
 margin:{estimatedContributionCents:58,estimatedMarginBps:3314},
 policy:{version:'profit-v1',eurPerUsdMicros:1000000,providerVatBps:2100,paymentFeeBps:1000,failureBufferBps:1000,preparationCents:5,minMarginBps:3000,dailyProviderLimitUsdMicros:10000000,minPriceCents:100,minProPriceCents:125,updatedAt:'2026-11-09T12:00:00Z'},
 jobs:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',createdAt:'2026-11-09T12:00:00Z',state:'completed',fundingKind:'credits',priceCents:175,estimatedCostCents:117,actualCostCents:null,estimatedMarginCents:58,canRecordFalCost:true}],expenses:[],warnings:[]
});
function fixture({handler,native=true,active=true,verificationHandler}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),win=dom.window,d=win.document,calls=[];
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;};
 let live=active;win.rigNativeSite=native;win.rigSessionActive=()=>live;
 const verifications=[];win.rigOwnerVerification={mount(){},cancel(){},async prepare(operation,payload){verifications.push({operation,payload:JSON.parse(JSON.stringify(payload))});return verificationHandler?verificationHandler(operation,payload):{challengeId:'11111111-1111-4111-8111-'+String(verifications.length).padStart(12,'0'),credential:{id:'test-only-assertion-'+verifications.length}};}};
 win.rigRequest=async(path,init={})=>{calls.push([path,init]);return handler?handler(path,init,calls):Response.json(summary());};
 win.eval(script);
 return {dom,win,d,calls,verifications,stop(){live=false;},close(){win.rigFinanceDispose?.();dom.window.close();}};
}
async function ready(f){await waitFor(()=>!f.d.getElementById('financeButton').hidden);return f;}
function submit(f,id){f.d.getElementById(id).dispatchEvent(new f.win.Event('submit',{bubbles:true,cancelable:true}));}

test('only an authorized owner response mounts private financial data; denied and anonymous visitors see none',async()=>{
 const denied=fixture({handler:()=>Response.json({error:'Geen toegang.'},{status:403})});
 try{
  await waitFor(()=>denied.calls.length===1);await new Promise(r=>setTimeout(r,10));
  assert.equal(denied.d.getElementById('financeButton').hidden,true);assert.equal(denied.d.getElementById('financeDialog'),null);
  assert.doesNotMatch(denied.d.body.textContent,/Ontvangen betalingen|Reserve voor btw|Werkelijk resultaat/);
  assert.equal(denied.calls.some(([,init])=>init.method==='POST'),false);
 }finally{denied.close();}
 for(const options of [{native:false},{active:false}]){
  const f=fixture(options);try{await new Promise(r=>setTimeout(r,10));assert.equal(f.calls.length,0);assert.equal(f.d.getElementById('financeDialog'),null);assert.equal(f.d.getElementById('financeButton').hidden,true);}finally{f.close();}
 }
});

test('owner sees cash, earned credits and outstanding liability separately, while missing actuals stay unknown',async()=>{
 const f=await ready(fixture());
 try{
  assert.match(f.d.getElementById('financeCash').textContent,/25,00/);assert.match(f.d.getElementById('financeEarned').textContent,/1,75/);assert.match(f.d.getElementById('financeLiability').textContent,/23,25/);assert.match(f.d.getElementById('financeMargin').textContent,/0,58/);
  const text=f.d.getElementById('financeDialog').textContent;assert.match(text,/Nog onbekend/);assert.match(text,/1 video-opdracht\(en\) missen werkelijke Fal-kosten/);assert.match(text,/vóór inkomstenbelasting/);assert.doesNotMatch(text,/US\$0,70/);
  assert.equal(f.d.getElementById('financePolicy-eurPerUsdMicros').value,'1');assert.equal(f.d.getElementById('financePolicy-providerVatBps').value,'21');assert.equal(f.d.getElementById('financePolicy-minProPriceCents').value,'1.25');
  f.d.getElementById('financeButton').click();assert.equal(f.d.getElementById('financeDialog').open,true);
 }finally{f.close();}
});

test('untrusted descriptions and job labels are text, not HTML',async()=>{
 const value=summary();value.expenses=[{id:'expense1',category:'other',date:'2026-11-09',amountCents:500,note:'<img src=x onerror=alert(1)>',jobId:null}];value.warnings=['<script>steal()</script>'];value.jobs[0].id='<img src=x onerror=alert(2)>';
 const f=await ready(fixture({handler:()=>Response.json(value)}));
 try{
  const dialog=f.d.getElementById('financeDialog');assert.match(dialog.textContent,/<img src=x onerror=alert\(1\)>/);assert.match(dialog.textContent,/<script>steal\(\)<\/script>/);assert.equal(dialog.querySelectorAll('img,script').length,0);
 }finally{f.close();}
});

test('a late initial response cannot reveal private figures after session binding changes',async()=>{
 const pending=deferred(),f=fixture({handler:()=>pending.promise});
 try{
  await waitFor(()=>f.calls.length===1);f.stop();pending.resolve(Response.json(summary()));await new Promise(r=>setTimeout(r,15));
  assert.equal(f.d.getElementById('financeButton').hidden,true);assert.equal(f.d.getElementById('financeDialog'),null);assert.doesNotMatch(f.d.body.textContent,/25,00|23,25/);
 }finally{f.close();}
});

test('logout removes financial data and a pending refresh cannot put it back',async()=>{
 const pending=deferred();let reads=0;
 const f=await ready(fixture({handler:()=>++reads===1?Response.json(summary()):pending.promise}));
 try{
  f.d.getElementById('financeButton').click();await waitFor(()=>reads===2);f.d.getElementById('authLogout').click();f.stop();
  assert.equal(f.d.getElementById('financeDialog'),null);assert.equal(f.d.getElementById('financeButton').hidden,true);
  pending.resolve(Response.json(summary()));await new Promise(r=>setTimeout(r,15));assert.equal(f.d.getElementById('financeDialog'),null);
 }finally{f.close();}
});

test('expense retry retains one idempotency key and prevents duplicate requests while saving',async()=>{
 const first=deferred();let posts=0;
 const f=await ready(fixture({handler:(path,init)=>{
  if(init.method==='POST'){posts++;return posts===1?first.promise:Response.json({saved:true});}return Response.json(summary());
 }}));
 try{
  f.d.getElementById('financeExpenseCategory').value='hosting';f.d.getElementById('financeExpenseDate').value='2026-11-09';f.d.getElementById('financeExpenseAmount').value='5,49';f.d.getElementById('financeExpenseNote').value='Cloudflare november';
  const form=f.d.getElementById('financeExpenseAmount').form;assert.ok(form);form.id='expenseForm';submit(f,'expenseForm');await waitFor(()=>posts===1);submit(f,'expenseForm');assert.equal(posts,1);
  first.resolve(Response.json({error:'Tijdelijk niet beschikbaar.'},{status:503}));await waitFor(()=>!form.querySelector('button').disabled);assert.match(f.d.getElementById('financeStatus').textContent,/Tijdelijk/);submit(f,'expenseForm');await waitFor(()=>posts===2);await waitFor(()=>!form.querySelector('button').disabled);
  const bodies=f.calls.filter(([,init])=>init.method==='POST').map(([,init])=>JSON.parse(init.body)),withoutProof=({verification,...body})=>body;assert.deepEqual(withoutProof(bodies[0]),withoutProof(bodies[1]));assert.notDeepEqual(bodies[0].verification,bodies[1].verification);assert.equal(bodies[0].amountCents,549);assert.equal(Object.hasOwn(bodies[0],'jobId'),false);assert.match(bodies[0].idempotencyKey,/^[a-f0-9-]{36}$/);assert.equal(f.d.getElementById('financeExpenseAmount').value,'');
 }finally{f.close();}
});

test('zero actual Fal cost requires an eligible known video and is not confused with a top-up',async()=>{
 const f=await ready(fixture());
 try{
  const category=f.d.getElementById('financeExpenseCategory');assert.equal(category.value,'fal-charge');assert.equal(f.d.getElementById('financeExpenseJob').options.length,2);
  f.d.getElementById('financeExpenseAmount').value='0';f.d.getElementById('financeExpenseDate').value='2026-11-09';f.d.getElementById('financeExpenseNote').value='Fal bevestigt geen kosten';const form=f.d.getElementById('financeExpenseAmount').form;form.id='expenseForm';submit(f,'expenseForm');await new Promise(r=>setTimeout(r,10));assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);
  f.d.getElementById('financeExpenseJob').value=summary().jobs[0].id;submit(f,'expenseForm');await waitFor(()=>f.calls.some(([,init])=>init.method==='POST'));
  const body=JSON.parse(f.calls.find(([,init])=>init.method==='POST')[1].body);assert.equal(body.category,'fal-charge');assert.equal(body.amountCents,0);assert.equal(body.jobId,summary().jobs[0].id);
 }finally{f.close();}
});

test('policy edits send scaled integers and the loaded version, without client ownership flags',async()=>{
 const f=await ready(fixture());
 try{
  f.d.getElementById('financePolicy-eurPerUsdMicros').value='0.94';f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value='15.50';
  const form=f.d.getElementById('financePolicy-eurPerUsdMicros').form;form.id='policyForm';submit(f,'policyForm');await waitFor(()=>f.calls.some(([,init])=>init.method==='POST'));
  const [path,init]=f.calls.find(([,init])=>init.method==='POST'),body=JSON.parse(init.body);assert.equal(path,'/api/owner/finance/policy');assert.equal(body.expectedVersion,'profit-v1');assert.equal(body.eurPerUsdMicros,940000);assert.equal(body.dailyProviderLimitUsdMicros,15500000);assert.equal(body.providerVatBps,2100);assert.equal(body.minPriceCents,100);assert.equal(body.minProPriceCents,125);assert.equal(Object.keys(body).length,11);assert.equal(Object.hasOwn(body,'owner'),false);assert.equal(f.verifications[0].operation,'finance-policy');assert.equal(Object.hasOwn(f.verifications[0].payload,'verification'),false);assert.deepEqual(body.verification.credential,{id:'test-only-assertion-1'});
 }finally{f.close();}
});

test('a late month response cannot replace the newest selected period',async()=>{
 const pending=deferred();const f=await ready(fixture({handler:path=>{
  if(path.endsWith('month=2026-10'))return pending.promise;const value=summary();if(path.endsWith('month=2026-11')){value.period.month='2026-11';value.income.cashReceivedCents=1000;}return Response.json(value);
 }}));
 try{
  const month=f.d.getElementById('financeMonth');month.value='2026-10';month.dispatchEvent(new f.win.Event('change'));await waitFor(()=>f.calls.some(([path])=>path.endsWith('month=2026-10')));month.value='2026-11';month.dispatchEvent(new f.win.Event('change'));await waitFor(()=>f.d.getElementById('financeCash').textContent.includes('10,00'));
  pending.resolve(Response.json(summary()));await new Promise(r=>setTimeout(r,15));assert.match(f.d.getElementById('financeCash').textContent,/10,00/);assert.equal(month.value,'2026-11');
 }finally{f.close();}
});

test('reserved customer credit remains a liability and historical missing estimates are not rendered as zero profit',async()=>{
 const value=summary();value.credits.heldCents=500;value.credits.liabilityCents=2825;value.credits.negativeBalanceCents=100;value.costs.missingEstimateJobs=1;value.costs.estimatedFalCents=null;value.margin.estimatedContributionCents=null;value.margin.estimatedMarginBps=null;value.margin.estimatedOperatingResultCents=null;
 const f=await ready(fixture({handler:()=>Response.json(value)}));
 try{assert.match(f.d.getElementById('financeLiability').textContent,/28,25/);assert.equal(f.d.getElementById('financeMargin').textContent,'Onbekend');assert.match(f.d.getElementById('financeDialog').textContent,/oudere video-opdracht\(en\) missen een kostenraming/);assert.match(f.d.getElementById('financeDialog').textContent,/Gereserveerd voor lopende video’s/);}finally{f.close();}
});

test('a concurrent policy change reloads the current values and never overwrites them automatically',async()=>{
 let posts=0;const value=summary();
 const f=await ready(fixture({handler:(path,init)=>{
  if(init.method==='POST'){posts++;value.policy.version='profit-v2';value.policy.dailyProviderLimitUsdMicros=20000000;return Response.json({error:'De instellingen zijn gewijzigd.'},{status:409});}
  return Response.json(value);
 }}));
 try{
  f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value='15';const form=f.d.getElementById('financePolicy-eurPerUsdMicros').form;form.id='policyForm';submit(f,'policyForm');
  await waitFor(()=>!form.querySelector('button').disabled);assert.equal(posts,1);assert.equal(f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value,'20');assert.match(f.d.getElementById('financeStatus').textContent,/ondertussen gewijzigd/);
 }finally{f.close();}
});

test('an expense correction preserves its audit link and the next new expense cannot inherit it',async()=>{
 const value=summary();value.expenses=[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',category:'hosting',date:'2026-11-09',amountCents:549,note:'Cloudflare verkeerd bedrag',jobId:null}];
 const f=await ready(fixture({handler:(path,init)=>Response.json(init.method==='POST'?{saved:true}:value)}));
 try{
  f.d.querySelector('.finance-correct').click();const amount=f.d.getElementById('financeExpenseAmount'),form=amount.form;form.id='expenseForm';
  assert.equal(f.d.getElementById('financeExpenseCategory').value,'hosting');assert.equal(f.d.getElementById('financeExpenseCategory').disabled,true);assert.equal(f.d.getElementById('financeExpenseDate').disabled,true);assert.equal(amount.value,'5,49');amount.value='6,49';f.d.getElementById('financeExpenseNote').value='Cloudflare gecorrigeerd';submit(f,'expenseForm');await waitFor(()=>!form.querySelector('button').disabled);
  let bodies=f.calls.filter(([,init])=>init.method==='POST').map(([,init])=>JSON.parse(init.body));assert.equal(bodies.length,1);assert.equal(bodies[0].replacesExpenseId,value.expenses[0].id);assert.equal(bodies[0].category,'hosting');assert.equal(bodies[0].date,'2026-11-09');assert.equal(bodies[0].amountCents,649);
  assert.equal(f.d.getElementById('financeExpenseCategory').disabled,false);assert.equal(f.d.getElementById('financeExpenseCategory').value,'fal-charge');assert.equal(amount.value,'');
  f.d.getElementById('financeExpenseCategory').value='hosting';f.d.getElementById('financeExpenseDate').value='2026-11-09';amount.value='1,00';f.d.getElementById('financeExpenseNote').value='Nieuwe kost';submit(f,'expenseForm');await waitFor(()=>f.calls.filter(([,init])=>init.method==='POST').length===2);
  bodies=f.calls.filter(([,init])=>init.method==='POST').map(([,init])=>JSON.parse(init.body));assert.equal(Object.hasOwn(bodies[1],'replacesExpenseId'),false);assert.notEqual(bodies[0].idempotencyKey,bodies[1].idempotencyKey);
 }finally{f.close();}
});

test('correcting an existing Fal charge permits its original job and cancelling removes the correction-only choice',async()=>{
 const value=summary();value.jobs[0].actualCostCents=100;value.jobs[0].canRecordFalCost=false;value.expenses=[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',category:'fal-charge',date:'2026-11-09',amountCents:100,note:'Oorspronkelijke Fal-kost',jobId:value.jobs[0].id}];
 const f=await ready(fixture({handler:()=>Response.json(value)}));
 try{
  assert.equal(f.d.getElementById('financeExpenseJob').options.length,1);f.d.querySelector('.finance-correct').click();assert.equal(f.d.getElementById('financeExpenseJob').value,value.jobs[0].id);assert.equal(f.d.getElementById('financeExpenseJob').disabled,true);
  const cancel=Array.from(f.d.querySelectorAll('#financeDialog button')).find(button=>button.textContent==='Nieuwe kost');assert.equal(cancel.hidden,false);cancel.click();
  assert.equal(f.d.getElementById('financeExpenseJob').options.length,1);assert.equal(f.d.getElementById('financeExpenseJob').disabled,false);assert.equal(f.d.getElementById('financeExpenseAmount').value,'');assert.equal(cancel.hidden,true);assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);
 }finally{f.close();}
});

test('a zero correction voids a mistyped cost, while a new non-Fal zero expense stays blocked',async()=>{
 const value=summary();value.jobs[0].recognizedAt='2026-11-10T12:00:00Z';value.expenses=[{id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',category:'other',date:'2026-11-09',amountCents:500,note:'Verkeerde registratie',jobId:null}];
 const f=await ready(fixture({handler:(path,init)=>Response.json(init.method==='POST'?{saved:true}:value)}));
 try{
  assert.match(f.d.querySelector('.finance-table').textContent,/10\/11\/2026/);assert.match(f.d.getElementById('financeDialog').textContent,/Registreren voert geen betaling uit en wijzigt geen RIG-saldo/);
  f.d.querySelector('.finance-correct').click();f.d.getElementById('financeExpenseAmount').value='0';f.d.getElementById('financeExpenseNote').value='Ongedaan gemaakt';const form=f.d.getElementById('financeExpenseAmount').form;form.id='expenseForm';submit(f,'expenseForm');await waitFor(()=>!form.querySelector('button').disabled);
  const bodies=f.calls.filter(([,init])=>init.method==='POST').map(([,init])=>JSON.parse(init.body));assert.equal(bodies.length,1);assert.equal(bodies[0].amountCents,0);assert.equal(bodies[0].category,'other');assert.equal(bodies[0].replacesExpenseId,value.expenses[0].id);
  f.d.getElementById('financeExpenseCategory').value='other';f.d.getElementById('financeExpenseDate').value='2026-11-09';f.d.getElementById('financeExpenseAmount').value='0';f.d.getElementById('financeExpenseNote').value='Nieuwe nulkost';submit(f,'expenseForm');await new Promise(r=>setTimeout(r,10));assert.equal(f.calls.filter(([,init])=>init.method==='POST').length,1);
 }finally{f.close();}
});

test('cancelled or setup-required verification never writes and keeps the financial overview readable',async()=>{
 for(const code of ['verification_cancelled','owner_security_setup_required']){
  const f=await ready(fixture({verificationHandler:()=>{throw Object.assign(Error('Bevestiging nodig.'),{code,status:428});}}));try{
   f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value='15';const form=f.d.getElementById('financePolicy-eurPerUsdMicros').form;form.id='policyForm';submit(f,'policyForm');await waitFor(()=>!form.querySelector('button').disabled);
   assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);assert.equal(f.d.getElementById('financeButton').hidden,false);assert.match(f.d.getElementById('financeStatus').textContent,/Bevestiging nodig/);assert.match(f.d.getElementById('financeCash').textContent,/25,00/);assert.equal(f.verifications.length,1);
  }finally{f.close();}
 }
});

test('a missing verification module blocks writes while keeping the overview readable',async()=>{
 const f=await ready(fixture());try{
  delete f.win.rigOwnerVerification;f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value='15';const form=f.d.getElementById('financePolicy-eurPerUsdMicros').form;form.id='policyForm';submit(f,'policyForm');await waitFor(()=>!form.querySelector('button').disabled);
  assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);assert.match(f.d.getElementById('financeStatus').textContent,/Vernieuw RIG/);assert.equal(f.d.getElementById('financeButton').hidden,false);
 }finally{f.close();}
});

test('an assertion arriving after logout never sends a financial write',async()=>{
 const pending=deferred(),f=await ready(fixture({verificationHandler:()=>pending.promise}));try{
  f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value='15';const form=f.d.getElementById('financePolicy-eurPerUsdMicros').form;form.id='policyForm';submit(f,'policyForm');await waitFor(()=>f.verifications.length===1);f.d.getElementById('authLogout').click();f.stop();pending.resolve({challengeId:'test-only-late-challenge',credential:{id:'test-only-late-assertion'}});await new Promise(r=>setTimeout(r,10));
  assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);assert.equal(f.d.getElementById('financeDialog'),null);
 }finally{f.close();}
});

test('a new policy version loaded during verification discards the obsolete action before writing',async()=>{
 const pending=deferred(),value=summary(),f=await ready(fixture({verificationHandler:()=>pending.promise,handler:()=>Response.json(value)}));try{
  f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value='15';const form=f.d.getElementById('financePolicy-eurPerUsdMicros').form;form.id='policyForm';submit(f,'policyForm');await waitFor(()=>f.verifications.length===1);value.policy.version='profit-v2';value.policy.dailyProviderLimitUsdMicros=8000000;
  const refresh=Array.from(f.d.querySelectorAll('#financeDialog button')).find(button=>button.textContent==='Vernieuwen');refresh.click();await waitFor(()=>f.calls.length===2);await waitFor(()=>f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value==='8');pending.resolve({challengeId:'test-only-old-version',credential:{id:'test-only-old-assertion'}});await waitFor(()=>!form.querySelector('button').disabled);
  assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);assert.match(f.d.getElementById('financeStatus').textContent,/ondertussen gewijzigd/);
 }finally{f.close();}
});

test('a safe decrease classified by the server sends the unchanged original policy without proof',async()=>{
 const f=await ready(fixture({verificationHandler:()=>null}));try{
  f.d.getElementById('financePolicy-dailyProviderLimitUsdMicros').value='5';const form=f.d.getElementById('financePolicy-eurPerUsdMicros').form;form.id='policyForm';submit(f,'policyForm');await waitFor(()=>f.calls.some(([,init])=>init.method==='POST'));
  const body=JSON.parse(f.calls.find(([,init])=>init.method==='POST')[1].body);assert.deepEqual(body,f.verifications[0].payload);assert.equal(Object.hasOwn(body,'verification'),false);assert.equal(body.dailyProviderLimitUsdMicros,5000000);
 }finally{f.close();}
});

test('an HTML authorization denial on refresh removes previously shown private financial data',async()=>{
 let denied=false;const f=await ready(fixture({handler:()=>denied?new Response('<h1>Forbidden</h1>',{status:403}):Response.json(summary())}));try{
  denied=true;f.d.getElementById('financeButton').click();await waitFor(()=>f.d.getElementById('financeDialog')===null);assert.equal(f.d.getElementById('financeButton').hidden,true);assert.doesNotMatch(f.d.body.textContent,/Ontvangen betalingen|23,25/);
 }finally{f.close();}
});

const salesReads=f=>f.calls.filter(([path])=>path==='/api/payments/readiness');
const refreshFinance=f=>Array.from(f.d.querySelectorAll('#financeDialog button')).find(button=>button.textContent==='Vernieuwen').click();
async function openSales(f){
 f.d.getElementById('financeButton').click();
 f.d.getElementById('financeSales').open=true;
 await waitFor(()=>salesReads(f).length>0);
}

test('owner explicitly checks current Mollie methods without creating a checkout or security challenge',async()=>{
 const f=await ready(fixture({handler:path=>Response.json(path==='/api/payments/readiness'?{ready:true,methods:['wero','ideal','bancontact']}:summary())}));
 try{
  await new Promise(r=>setTimeout(r,10));assert.equal(salesReads(f).length,0);
  f.d.getElementById('financeButton').click();await new Promise(r=>setTimeout(r,10));assert.equal(salesReads(f).length,0);
  f.d.getElementById('financeSales').open=true;await waitFor(()=>f.d.getElementById('financeSalesMethods').textContent.includes('Wero'));
  assert.equal(salesReads(f).length,1);assert.match(f.d.getElementById('financeSalesMethods').textContent,/Wero, iDEAL, Bancontact/);
  assert.match(f.d.getElementById('financeSalesStatus').textContent,/5,00/);assert.match(f.d.getElementById('financeSalesChecked').textContent,/Gecontroleerd om/);
  assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);assert.equal(f.verifications.length,0);
  assert.equal(salesReads(f)[0][1].cache,'no-store');
 }finally{f.close();}
});

test('a pending Mollie check shows progress and repeated refresh cannot duplicate it',async()=>{
 const pending=deferred(),f=await ready(fixture({handler:path=>path==='/api/payments/readiness'?pending.promise:Response.json(summary())}));
 try{
  await openSales(f);assert.match(f.d.getElementById('financeSalesStatus').textContent,/controleren/);
  refreshFinance(f);await waitFor(()=>!f.d.querySelector('.finance-toolbar button').disabled);
  f.d.getElementById('financeSales').dispatchEvent(new f.win.Event('toggle'));
  assert.equal(salesReads(f).length,1);assert.match(f.d.getElementById('financeCash').textContent,/25,00/);
  pending.resolve(Response.json({ready:false,methods:[],reason:'no_enabled_methods'}));await waitFor(()=>f.d.getElementById('financeSalesStatus').textContent.includes('geen betaalmethode'));
  assert.equal(f.d.getElementById('financeSalesMethods').textContent,'');assert.equal(f.d.getElementById('financeSalesStatus').dataset.error,'true');
 }finally{f.close();}
});

test('a failed refresh clears old available methods and a later retry restores current status',async()=>{
 let reads=0;const responses=[()=>Response.json({ready:true,methods:['wero']}),()=>new Response('unavailable',{status:503}),()=>Response.json({ready:true,methods:['bancontact']})];
 const f=await ready(fixture({handler:path=>path==='/api/payments/readiness'?responses[reads++]():Response.json(summary())}));
 try{
  await openSales(f);await waitFor(()=>f.d.getElementById('financeSalesMethods').textContent.includes('Wero'));
  refreshFinance(f);await waitFor(()=>f.d.getElementById('financeSalesStatus').textContent.includes('tijdelijk niet beschikbaar'));
  assert.equal(f.d.getElementById('financeSalesMethods').textContent,'');await waitFor(()=>!f.d.querySelector('.finance-toolbar button').disabled);
  refreshFinance(f);await waitFor(()=>f.d.getElementById('financeSalesMethods').textContent.includes('Bancontact'));
  assert.doesNotMatch(f.d.getElementById('financeSalesMethods').textContent,/Wero/);assert.equal(salesReads(f).length,3);
 }finally{f.close();}
});

test('invalid provider status never claims payments are available or renders provider markup',async()=>{
 for(const value of [{ready:true,methods:[]},{ready:true,methods:['wero','wero']},{ready:true,methods:['wero'],reason:'provider_unavailable'},{ready:true,methods:['<img src=x onerror=alert(1)>']},{ready:false,methods:[],reason:{error:'blocked'}}]){
  const f=await ready(fixture({handler:path=>Response.json(path==='/api/payments/readiness'?value:summary())}));
  try{
   await openSales(f);await waitFor(()=>f.d.getElementById('financeSalesStatus').dataset.error==='true');
   assert.match(f.d.getElementById('financeSalesStatus').textContent,/tijdelijk niet beschikbaar/);assert.equal(f.d.getElementById('financeSalesMethods').textContent,'');assert.equal(f.d.getElementById('financeSales').querySelector('img'),null);
  }finally{f.close();}
 }
 for(const value of [{ready:true,methods:['constructor']},{ready:false,methods:[],reason:'constructor'}]){
  const f=await ready(fixture({handler:path=>Response.json(path==='/api/payments/readiness'?value:summary())}));
  try{
   await openSales(f);await waitFor(()=>f.d.getElementById('financeSalesChecked').textContent.startsWith('Gecontroleerd'));
   assert.doesNotMatch(f.d.getElementById('financeSales').textContent,/function Object|\[native code\]/);
   assert.match(f.d.getElementById('financeSales').textContent,value.ready?/Andere betaalmethode/:/momenteel niet beschikbaar/);
  }finally{f.close();}
 }
});

test('logout or account replacement while Mollie responds cannot restore the owner sales panel',async()=>{
 for(const logout of [true,false]){
  const pending=deferred(),f=await ready(fixture({handler:path=>path==='/api/payments/readiness'?pending.promise:Response.json(summary())}));
  try{
   await openSales(f);if(logout){f.d.getElementById('authLogout').click();f.stop();}else f.win.rigRequest=async()=>Response.json(summary());
   pending.resolve(Response.json({ready:true,methods:['wero']}));await waitFor(()=>f.d.getElementById('financeDialog')===null);
   assert.equal(f.d.getElementById('financeButton').hidden,true);assert.doesNotMatch(f.d.body.textContent,/Betaalmethoden: Wero/);
  }finally{f.close();}
 }
});

const coverage=()=>({enabled:true,status:'ready',availableUsdMicros:21390000,requiredUsdMicros:6000000,headroomUsdMicros:15390000,newCreditCapacityCents:3413,fetchedAt:Date.now()-100,expiresAt:Date.now()+59900});
const fundingReads=f=>f.calls.filter(([path])=>path==='/api/owner/finance/funding');
test('owner opens stock coverage alongside Mollie methods without enabling auto top-up or changing policy',async()=>{
 const f=await ready(fixture({handler:path=>Response.json(path==='/api/owner/finance/funding'?coverage():path==='/api/payments/readiness'?{ready:true,methods:['wero']}:summary())}));
 try{
  assert.equal(fundingReads(f).length,0);await openSales(f);await waitFor(()=>f.d.getElementById('financeFundingFigures').textContent.includes('21,39'));
  assert.match(f.d.getElementById('financeFundingStatus').textContent,/34,13/);assert.match(f.d.getElementById('financeFundingFigures').textContent,/6,00/);assert.match(f.d.getElementById('financeFundingChecked').textContent,/geen tijdstip van het onderliggende saldo/);
  assert.match(f.d.getElementById('financeSalesMethods').textContent,/Bij Mollie beschikbaar: Wero/);assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);assert.equal(f.verifications.length,0);assert.equal(fundingReads(f)[0][1].cache,'no-store');
 }finally{f.close();}
});

test('insufficient coverage explains that new sales pause while existing payments continue',async()=>{
 const value={...coverage(),status:'insufficient',availableUsdMicros:1390000,headroomUsdMicros:-4610000,newCreditCapacityCents:0};
 const f=await ready(fixture({handler:path=>Response.json(path==='/api/owner/finance/funding'?value:path==='/api/payments/readiness'?{ready:false,methods:['wero'],reason:'funding_unavailable'}:summary())}));
 try{
  await openSales(f);await waitFor(()=>f.d.getElementById('financeFundingFigures').textContent.includes('Tekort'));
  assert.match(f.d.getElementById('financeFundingStatus').textContent,/gepauzeerd/);assert.match(f.d.getElementById('financeSalesStatus').textContent,/Bestaande betalingen worden verder verwerkt/);assert.match(f.d.getElementById('financeSalesMethods').textContent,/Wero/);assert.match(f.d.getElementById('financeFundingFigures').textContent,/4,61/);
 }finally{f.close();}
});

test('setup and failed or stale stock reads never retain old figures or claim active protection',async()=>{
 for(const value of [{enabled:false,status:'setup'},coverage(),{...coverage(),expiresAt:Date.now()-1},summary()]){
  let reads=0;
  const f=await ready(fixture({handler:path=>path==='/api/owner/finance/funding'?(++reads===1?Response.json(value):new Response('offline',{status:503})):Response.json(path==='/api/payments/readiness'?{ready:false,methods:[],reason:'funding_unavailable'}:summary())}));
  try{
   await openSales(f);await waitFor(()=>!f.d.getElementById('financeFundingStatus').textContent.includes('controleren…'));
   if(value.enabled===false)assert.match(f.d.getElementById('financeFundingStatus').textContent,/moet nog worden ingesteld/);
   if(value.enabled!==true||value.expiresAt<=Date.now())assert.equal(f.d.getElementById('financeFundingFigures').textContent,'');
   await waitFor(()=>!f.d.querySelector('.finance-toolbar button').disabled);refreshFinance(f);await waitFor(()=>reads===2&&f.d.getElementById('financeFundingStatus').textContent.includes('niet als gereed bevestigd'));
   assert.equal(f.d.getElementById('financeFundingFigures').textContent,'');assert.equal(f.d.getElementById('financeFundingChecked').textContent,'');
  }finally{f.close();}
 }
});

test('a late stock response cannot disclose provider finances after logout or a new account binding',async()=>{
 for(const logout of [true,false]){
  const pending=deferred(),f=await ready(fixture({handler:path=>path==='/api/owner/finance/funding'?pending.promise:Response.json(path==='/api/payments/readiness'?{ready:true,methods:['wero']}:summary())}));
  try{
   await openSales(f);await waitFor(()=>fundingReads(f).length===1);if(logout){f.d.getElementById('authLogout').click();f.stop();}else f.win.rigRequest=async()=>Response.json(summary());
   pending.resolve(Response.json(coverage()));await waitFor(()=>f.d.getElementById('financeDialog')===null);assert.doesNotMatch(f.d.body.textContent,/21,39|34,13/);
  }finally{f.close();}
 }
});

test('cached page transitions preserve financial controls and drafts; actual unload still removes private data',async()=>{
 const f=await ready(fixture());try{
  f.d.getElementById('financeButton').click();await waitFor(()=>f.d.getElementById('financeDialog').open);await waitFor(()=>f.calls.length===2);await waitFor(()=>!f.d.querySelector('.finance-toolbar button').disabled);const dialog=f.d.getElementById('financeDialog');
  f.d.getElementById('financeExpenseNote').value='Mijn onopgeslagen omschrijving';const before=f.calls.length;
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:true}));f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow',{persisted:true}));
  assert.equal(f.d.getElementById('financeDialog'),dialog);assert.equal(f.d.getElementById('financeButton').hidden,false);assert.equal(f.d.getElementById('financeExpenseNote').value,'Mijn onopgeslagen omschrijving');assert.equal(f.calls.length,before);assert.equal(f.calls.some(([,init])=>init.method==='POST'),false);
  dialog.close();f.d.getElementById('financeButton').click();await waitFor(()=>f.calls.length===before+1);assert.equal(dialog.open,true);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:false}));assert.equal(f.d.getElementById('financeDialog'),null);assert.equal(f.d.getElementById('financeButton').hidden,true);
 }finally{f.close();}
});
