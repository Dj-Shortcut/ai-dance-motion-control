import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const script=readFileSync(new URL('./frontend/multiuser/owner-administration.js',import.meta.url),'utf8');
const ORDER='11111111-1111-4111-8111-111111111111',DOCUMENT='22222222-2222-4222-8222-222222222222',CASE='33333333-3333-4333-8333-333333333333',VERSION='a'.repeat(64);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const waitFor=async(fn)=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Administration UI did not settle');};
const plain=value=>JSON.parse(JSON.stringify(value));
const data=()=>({provider:'accountable',connection:'manual',formalAccountingComplete:false,paidPurchaseCount:1,purchasesWithoutReference:1,verifiedGrossReceiptsCents:500,outstandingCreditLiabilityCents:500,documents:[],checklist:[{id:'bank',text:'Stem betalingen af met je bank.'}],purchases:[{orderId:ORDER,orderReference:'RIG-'+ORDER,paymentReference:'tr_12345678',state:'paid',currentlyPaid:true,createdAt:'2026-11-09 12:00:00',creditedAt:'2026-11-09 12:00:00',orderAmountCents:500,verifiedReceiptCents:500,document:null}]});
const recoveryCase=(overrides={})=>({kind:'payment',id:CASE,state:'unknown',version:VERSION,amountCents:500,providerRequestId:null,nextStep:'Controleer de bestaande betaling bij Mollie.',notes:[],...overrides});
function fixture({handler,verificationHandler,native=true,active=true,value=data(),cases=[],requests=[]}={}){
 const dom=new JSDOM('<button id="authLogout">Afmelden</button><section id="admin"></section>',{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),win=dom.window,d=win.document,calls=[],verifications=[],downloads=[],created=[],revoked=[];let live=active,cancels=0,changes=0;
 win.rigNativeSite=native;win.rigSessionActive=()=>live;win.rigOwnerVerification={cancel(){cancels++;},async prepare(operation,payload){verifications.push({operation,payload:plain(payload)});return verificationHandler?verificationHandler(operation,payload):{challengeId:'test-device-proof',credential:{id:'assertion-'+verifications.length}};}};
 win.rigRequest=async(path,init={})=>{calls.push([path,init]);if(handler)return handler(path,init,calls);if(init.method==='POST')return Response.json({recorded:true});if(path.startsWith('/api/owner/accounting/export/'))return new Response('\ufeff"row"\r\n',{headers:{'content-type':'text/csv; charset=utf-8'}});return Response.json(path.startsWith('/api/owner/accounting')?value:path==='/api/owner/recovery'?{cases}:{cases:requests});};
 win.URL.createObjectURL=blob=>{created.push(blob);return 'blob:local-private-'+created.length;};win.URL.revokeObjectURL=url=>revoked.push(url);win.HTMLAnchorElement.prototype.click=function(){downloads.push({href:this.href,name:this.download});};
 win.eval(script);const root=d.getElementById('admin');win.rigOwnerAdministration?.mount(root,{onChanged(){changes++;}});
 return {dom,win,d,root,calls,verifications,downloads,created,revoked,stop(){live=false;},get changes(){return changes;},get cancels(){return cancels;},close(){win.rigOwnerAdministration?.dispose();win.close();}};
}
function open(f,label){const item=[...f.root.children].find(node=>node.querySelector('summary')?.textContent===label);assert.ok(item,label);item.open=true;item.dispatchEvent(new f.win.Event('toggle'));return item;}
async function accounting(f){open(f,'Administratie voor Accountable');await waitFor(()=>f.d.getElementById('ownerAccountingDocumentForm'));return f;}
async function recovery(f){const details=open(f,'Probleemgevallen en klantvragen');await waitFor(()=>details.querySelector('.finance-status').textContent.startsWith('Bijgewerkt.'));return details;}
function submit(f,form){form.dispatchEvent(new f.win.Event('submit',{bubbles:true,cancelable:true}));}
function referenceForm(f){f.d.getElementById('ownerAccountingReference').value='ACC-2026-001';return f.d.getElementById('ownerAccountingDocumentForm');}
const posts=f=>f.calls.filter(([,init])=>init.method==='POST');

test('mount is closed and makes no requests; owner data loads only when the corresponding disclosure opens',async()=>{
 const f=fixture();try{
  await new Promise(r=>setTimeout(r,10));assert.equal(f.calls.length,0);assert.equal(f.verifications.length,0);assert.equal(f.root.querySelectorAll(':scope > details').length,2);assert.equal([...f.root.children].every(node=>node.open===false),true);
  await accounting(f);assert.deepEqual(f.calls.map(([path])=>path),['/api/owner/accounting']);assert.match(f.root.textContent,/niet automatisch verbonden/);assert.match(f.root.textContent,/handmatig door jou geregistreerd/);assert.match(f.root.textContent,/Volledig werkelijk resultaat: nog onbekend/);assert.equal(f.root.querySelectorAll('[data-export-kind]').length,4);assert.equal(f.verifications.length,0);
  await recovery(f);assert.deepEqual(f.calls.map(([path])=>path),['/api/owner/accounting','/api/owner/recovery','/api/owner/support']);assert.equal(posts(f).length,0);
 }finally{f.close();}
 for(const options of [{native:false},{active:false}]){const f=fixture(options);try{assert.equal(f.calls.length,0);assert.equal(f.root.children.length,0);}finally{f.close();}}
});

test('private administration uses text nodes for seller references, checklist and customer messages',async()=>{
 const value=data();value.purchases[0].orderReference='<img src=x onerror=alert(1)>';value.checklist[0].text='<script>steal()</script>';
 const f=fixture({value,requests:[{id:'req',kind:'withdrawal',createdAt:'2026-11-09T12:00:00Z',orderRequestId:ORDER,message:'<svg onload=steal()>please refund</svg>'}],cases:[recoveryCase({nextStep:'<img src=x>'})]});try{
  await accounting(f);await recovery(f);assert.match(f.root.textContent,/<img src=x onerror/);assert.match(f.root.textContent,/<script>steal/);assert.match(f.root.textContent,/<svg onload/);assert.equal(f.root.querySelectorAll('img,script,svg,iframe').length,0);assert.match(f.root.textContent,/geen beslissing of terugbetaling uitgevoerd/);
 }finally{f.close();}
});

test('document records wait for device proof, submit exact fields and retain an idempotency key after an uncertain response',async()=>{
 const proof=deferred(),reply=deferred();let attempts=0;const f=fixture({verificationHandler:()=>proof.promise,handler:(path,init)=>init.method==='POST'?(++attempts===1?reply.promise:Response.json({recorded:true})):Response.json(data())});
 try{
  await accounting(f);const form=referenceForm(f);submit(f,form);await waitFor(()=>f.verifications.length===1);assert.equal(posts(f).length,0);assert.equal([...form.elements].every(field=>field.disabled),true);submit(f,form);assert.equal(f.verifications.length,1);
  proof.resolve({challengeId:'proof',credential:{id:'device'}});await waitFor(()=>posts(f).length===1);submit(f,form);assert.equal(posts(f).length,1);
  const payload=f.verifications[0].payload,body=JSON.parse(posts(f)[0][1].body);assert.equal(f.verifications[0].operation,'accounting-document');assert.equal(payload.orderId,ORDER);assert.equal(payload.recordType,'invoice');assert.equal(payload.deliveryStatus,'prepared');assert.equal(payload.externalInvoiceReference,'ACC-2026-001');assert.deepEqual(Object.keys(payload).sort(),['idempotencyKey','orderId','externalInvoiceReference','documentDate','recordType','deliveryStatus','note'].sort());assert.deepEqual(body,{...payload,verification:{challengeId:'proof',credential:{id:'device'}}});
  reply.resolve(Response.json({error:'Uitkomst tijdelijk onbekend.'},{status:503}));await waitFor(()=>!form.querySelector('button[type=submit]').disabled);submit(f,form);await waitFor(()=>posts(f).length===2);assert.equal(JSON.parse(posts(f)[1][1].body).idempotencyKey,body.idempotencyKey);await waitFor(()=>f.changes===1);assert.match(f.root.textContent,/geen factuur of Peppol-bericht verstuurd/);
 }finally{f.close();}
});

test('manual invoice corrections name the effective previous document and do not report Peppol delivery as provider-confirmed',async()=>{
 const value=data();value.documents=[{id:DOCUMENT,orderId:ORDER,externalInvoiceReference:'ACC-old',documentDate:'2026-11-09',recordType:'invoice',deliveryStatus:'recorded-in-accountable',note:'Oude registratie'}];value.purchases[0].document=value.documents[0];
 const f=fixture({value});try{
  await accounting(f);const form=referenceForm(f);f.d.getElementById('ownerAccountingDelivery').value='peppol-sent-manually';assert.match(form.textContent,/vorige registratie blijft bewaard/);submit(f,form);await waitFor(()=>posts(f).length===1);const body=JSON.parse(posts(f)[0][1].body);assert.equal(body.replacesDocumentId,DOCUMENT);assert.equal(body.deliveryStatus,'peppol-sent-manually');assert.equal(Object.hasOwn(body,'providerConfirmed'),false);assert.match(f.root.textContent,/RIG bevestigt|door jou geregistreerd|jouw handmatige registratie/);
 }finally{f.close();}
});

test('cancelled or edited device prompts never send a document mutation; logout removes all private data',async()=>{
 for(const scenario of ['cancel','edit','logout']){
  const pending=deferred(),f=fixture({verificationHandler:()=>pending.promise});try{
   await accounting(f);const form=referenceForm(f);submit(f,form);await waitFor(()=>f.verifications.length===1);
   if(scenario==='edit'){f.d.getElementById('ownerAccountingReference').value='ACC-changed';form.dispatchEvent(new f.win.Event('input'));}if(scenario==='logout'){f.d.getElementById('authLogout').click();f.stop();}
   pending.resolve(scenario==='cancel'?null:{challengeId:'proof',credential:{id:'device'}});await new Promise(r=>setTimeout(r,15));assert.equal(posts(f).length,0);if(scenario==='logout'){assert.equal(f.root.children.length,0);assert.ok(f.cancels>=1);}else assert.match(f.root.textContent,scenario==='edit'?/gegevens zijn gewijzigd/:/niet afgerond/);
  }finally{f.close();}
 }
});

test('CSV files use authenticated same-origin requests and browser blobs without exposing credentials in URLs',async()=>{
 const f=fixture();try{
  await accounting(f);const month=f.d.getElementById('ownerAccountingMonth');month.value='2026-11';month.dispatchEvent(new f.win.Event('change'));await waitFor(()=>f.calls.some(([path])=>path==='/api/owner/accounting?month=2026-11'));await waitFor(()=>!f.root.querySelector('details .finance-toolbar button').disabled);
  f.d.querySelector('[data-export-kind=costs]').click();await waitFor(()=>f.downloads.length===1);assert.equal(f.calls.at(-1)[0],'/api/owner/accounting/export/costs.csv?month=2026-11');assert.equal(f.calls.at(-1)[1].cache,'no-store');assert.equal(f.downloads[0].href,'blob:local-private-1');assert.equal(f.downloads[0].name,'RIG-costs-2026-11.csv');assert.doesNotMatch(f.downloads[0].href,/token|authorization|api\/owner/);f.win.rigOwnerAdministration.dispose();assert.deepEqual(f.revoked,['blob:local-private-1']);
 }finally{f.close();}
});

test('a late CSV read cannot produce a download after logout or session loss',async()=>{
 const pending=deferred();const f=fixture({handler:(path)=>path.includes('/export/')?pending.promise:Response.json(data())});try{
  await accounting(f);f.d.querySelector('[data-export-kind=purchases]').click();await waitFor(()=>f.calls.some(([path])=>path.includes('/export/')));f.stop();pending.resolve(new Response('private',{headers:{'content-type':'text/csv'}}));await new Promise(r=>setTimeout(r,15));assert.equal(f.created.length,0);assert.equal(f.downloads.length,0);assert.equal(f.root.children.length,0);
 }finally{f.close();}
});

test('recovery notes and existing-payment verification require separate exact proofs and never retry Fal or create payments',async()=>{
 const f=fixture({cases:[recoveryCase(),recoveryCase({id:ORDER,kind:'generation',fundingKind:'owner-provider',amountCents:0,providerRequestId:'fal-existing-request'})]});try{
  await recovery(f);assert.match(f.root.textContent,/Eigen Fal-opdracht, geen klanttegoed/);let form=f.root.querySelector('form[data-recovery-kind=payment]');form.querySelector('textarea').value='Mollie-bewijs nagekeken';submit(f,form);await waitFor(()=>posts(f).length===1);assert.equal(f.verifications[0].operation,'recovery-note');assert.equal(f.verifications[0].payload.caseId,CASE);assert.equal(f.verifications[0].payload.expectedVersion,VERSION);assert.equal(posts(f)[0][0],'/api/owner/recovery/notes');assert.deepEqual(JSON.parse(posts(f)[0][1].body),{...f.verifications[0].payload,verification:{challengeId:'test-device-proof',credential:{id:'assertion-1'}}});await waitFor(()=>f.root.textContent.includes('Onderzoeksnotitie bewaard.'));
  form=f.root.querySelector('form[data-payment-case]');form.querySelector('input').value='tr_12345678';submit(f,form);await waitFor(()=>posts(f).length===2);const proof=f.verifications[1],body=JSON.parse(posts(f)[1][1].body);assert.equal(proof.operation,'recovery-payment');assert.equal(proof.payload.orderId,CASE);assert.equal(proof.payload.providerPaymentId,'tr_12345678');assert.equal(posts(f)[1][0],'/api/owner/recovery/payments/'+CASE+'/adopt');assert.deepEqual(Object.keys(body).sort(),['idempotencyKey','expectedVersion','providerPaymentId','verification'].sort());assert.equal(body.expectedVersion,VERSION);assert.equal(body.providerPaymentId,'tr_12345678');assert.equal(f.calls.some(([path])=>/fal|generate|refund|payments\/checkout/.test(path)),false);
 }finally{f.close();}
});

test('denied owner responses clear data and an obsolete month response cannot recreate private content',async()=>{
 const pending=deferred();let denied=false;const f=fixture({handler:path=>path.includes('month=2026-10')?pending.promise:denied?Response.json({error:'Geen toegang'},{status:403}):Response.json(data())});try{
  await accounting(f);const month=f.d.getElementById('ownerAccountingMonth');month.value='2026-10';month.dispatchEvent(new f.win.Event('change'));await waitFor(()=>f.calls.some(([path])=>path.includes('month=2026-10')));denied=true;month.value='2026-11';month.dispatchEvent(new f.win.Event('change'));await waitFor(()=>f.root.children.length===0);pending.resolve(Response.json(data()));await new Promise(r=>setTimeout(r,15));assert.equal(f.root.children.length,0);assert.equal(f.verifications.length,0);
 }finally{f.close();}
});

const issuedRow=()=>({id:DOCUMENT,orderId:ORDER,number:'RIG-2026-000001',issuedDate:'2026-11-09',amountCents:500,currency:'EUR',pdfReady:true,mailState:'sent',accountableValidated:false,pdfPath:'https://attacker.invalid/stolen.pdf'});
const invoiceIndex=(rows=[issuedRow()])=>({automaticIssuanceEnabled:true,accountableDeliveryConfigured:false,accountableValidated:false,peppolDeliveryVerified:false,hasMore:false,invoices:rows});
function automaticData(){const value=data();value.automaticInvoiceIssuance=true;value.accountableDeliveryConfigured=false;value.purchases[0].invoice=issuedRow();return value;}

test('automatic invoices show original documents and honest mail status with authenticated PDF and monthly ZIP downloads',async()=>{
 const value=automaticData(),f=fixture({handler:(path)=>path.startsWith('/api/owner/accounting')?Response.json(value):path.startsWith('/api/owner/invoices/export.zip')?new Response('zip-file',{headers:{'content-type':'application/zip'}}):path.endsWith('/pdf')?new Response('%PDF-fixture',{headers:{'content-type':'application/pdf'}}):Response.json(invoiceIndex())});
 try{
  await accounting(f);await waitFor(()=>f.root.querySelector('[data-invoice-pdf]'));assert.match(f.root.textContent,/originele factuur uit/);assert.match(f.root.textContent,/maak geen tweede verkoopfactuur/);assert.match(f.root.textContent,/Factuurmail is nog niet ingesteld/);assert.match(f.root.textContent,/Mail door verzenddienst aanvaard; controle in Accountable blijft nodig/);assert.match(f.root.textContent,/Boeking en Peppol-bezorging zijn niet bevestigd/);assert.equal(f.root.querySelector('[data-invoice-zip]').disabled,true);
  f.root.querySelector('[data-invoice-pdf]').click();await waitFor(()=>f.downloads.length===1);assert.equal(f.calls.at(-1)[0],'/api/owner/invoices/'+DOCUMENT+'/pdf');assert.equal(f.downloads[0].name,'RIG-2026-000001.pdf');assert.equal(f.downloads[0].href,'blob:local-private-1');assert.equal(f.calls.some(([path])=>path.includes('attacker.invalid')),false);
  const month=f.d.getElementById('ownerAccountingMonth');month.value='2026-11';month.dispatchEvent(new f.win.Event('change'));await waitFor(()=>f.calls.some(([path])=>path==='/api/owner/invoices?month=2026-11'));await waitFor(()=>f.root.querySelector('[data-invoice-zip]')?.disabled===false);f.root.querySelector('[data-invoice-zip]').click();await waitFor(()=>f.downloads.length===2);assert.equal(f.calls.at(-1)[0],'/api/owner/invoices/export.zip?month=2026-11');assert.equal(f.downloads[1].name,'RIG-facturen-2026-11.zip');assert.equal(posts(f).length,0);assert.equal(f.verifications.length,0);
 }finally{f.close();}
});

test('issued invoice defaults lock the exact original number while an external accounting entry remains possible',async()=>{
 const value=automaticData(),f=fixture({handler:(path,init)=>init.method==='POST'?Response.json({recorded:true}):path.startsWith('/api/owner/accounting')?Response.json(value):Response.json(invoiceIndex())});try{
  await accounting(f);await waitFor(()=>f.root.querySelector('[data-invoice-pdf]'));const form=f.d.getElementById('ownerAccountingDocumentForm'),ref=f.d.getElementById('ownerAccountingReference'),kind=f.d.getElementById('ownerAccountingRecordType');assert.equal(ref.value,'RIG-2026-000001');assert.equal(ref.readOnly,true);assert.match(form.textContent,/originele factuur bestaat al/);
  kind.value='accounting-entry';kind.dispatchEvent(new f.win.Event('change'));assert.equal(ref.readOnly,false);assert.equal(ref.value,'');ref.value='ACC-book-27';await waitFor(()=>!f.root.querySelector('details .finance-toolbar button').disabled);submit(f,form);await waitFor(()=>posts(f).length===1);const body=JSON.parse(posts(f)[0][1].body);assert.equal(body.recordType,'accounting-entry');assert.equal(body.externalInvoiceReference,'ACC-book-27');assert.equal(f.verifications[0].operation,'accounting-document');
 }finally{f.close();}
});

test('invoice-list failures preserve administration, but an authorization denial clears all owner data',async()=>{
 for(const status of [503,403]){const f=fixture({handler:path=>path.startsWith('/api/owner/accounting')?Response.json(automaticData()):Response.json({error:'Facturen niet beschikbaar.'},{status})});try{
  open(f,'Administratie voor Accountable');await waitFor(()=>f.calls.some(([path])=>path==='/api/owner/invoices'));await new Promise(r=>setTimeout(r,15));if(status===403)assert.equal(f.root.children.length,0);else{assert.match(f.root.textContent,/Facturen niet beschikbaar/);assert.equal(f.root.querySelectorAll('[data-export-kind]').length,4);assert.ok(f.d.getElementById('ownerAccountingDocumentForm'));}assert.equal(posts(f).length,0);
 }finally{f.close();}}
});

test('an invoice document response cannot download private bytes after logout and HTML masquerading as a PDF is rejected',async()=>{
 const pending=deferred(),f=fixture({handler:path=>path.endsWith('/pdf')?pending.promise:path.startsWith('/api/owner/accounting')?Response.json(automaticData()):Response.json(invoiceIndex())});try{
  await accounting(f);await waitFor(()=>f.root.querySelector('[data-invoice-pdf]'));f.root.querySelector('[data-invoice-pdf]').click();await waitFor(()=>f.calls.some(([path])=>path.endsWith('/pdf')));f.d.getElementById('authLogout').click();f.stop();pending.resolve(new Response('%PDF-private',{headers:{'content-type':'application/pdf'}}));await new Promise(r=>setTimeout(r,15));assert.equal(f.downloads.length,0);assert.equal(f.created.length,0);assert.equal(f.root.children.length,0);
 }finally{f.close();}
 const html=fixture({handler:path=>path.endsWith('/pdf')?new Response('<html>not a PDF</html>',{headers:{'content-type':'text/html'}}):path.startsWith('/api/owner/accounting')?Response.json(automaticData()):Response.json(invoiceIndex())});try{
  await accounting(html);await waitFor(()=>html.root.querySelector('[data-invoice-pdf]'));html.root.querySelector('[data-invoice-pdf]').click();await waitFor(()=>html.root.textContent.includes('geen geldig factuurbestand'));assert.equal(html.downloads.length,0);
 }finally{html.close();}
});

test('paid purchases needing invoice review remain visible even when there is no issued-invoice row',async()=>{
 const value=automaticData();value.purchases[0].invoice=null;value.purchases[0].invoiceIssueState='review-required';value.purchases[0].invoiceIssueReason='billing_missing';const f=fixture({handler:path=>path.startsWith('/api/owner/accounting')?Response.json(value):Response.json(invoiceIndex([]))});try{
  await accounting(f);await waitFor(()=>f.root.textContent.includes('Nog geen uitgegeven facturen'));const warning=f.root.querySelector('[data-invoice-review]');assert.ok(warning);assert.equal(warning.dataset.invoiceReview,ORDER);assert.match(warning.textContent,/Factuur controleren · Factuuradres ontbreekt/);assert.equal(f.root.querySelector('[data-invoice-pdf]'),null);assert.equal(f.verifications.length,0);
 }finally{f.close();}
});

test('cached page transitions preserve manual administration without new mutations and actual unload clears it',async()=>{
 const f=fixture();try{
  await accounting(f);const form=f.d.getElementById('ownerAccountingDocumentForm');f.d.getElementById('ownerAccountingReference').value='ACC-mijn-bewaarde-keuze';const before=f.calls.length;
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:true}));f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow',{persisted:true}));
  assert.equal(f.d.getElementById('ownerAccountingDocumentForm'),form);assert.equal(f.d.getElementById('ownerAccountingReference').value,'ACC-mijn-bewaarde-keuze');assert.equal(f.calls.length,before);assert.equal(posts(f).length,0);
  await recovery(f);assert.ok(f.calls.some(([path])=>path==='/api/owner/recovery'));assert.equal(posts(f).length,0);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:false}));assert.equal(f.root.children.length,0);
 }finally{f.close();}
});
