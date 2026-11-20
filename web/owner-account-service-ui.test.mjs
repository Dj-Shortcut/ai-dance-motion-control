import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const script=readFileSync(new URL('./frontend/multiuser/owner-administration.js',import.meta.url),'utf8');
const USER='u-11111111-1111-4111-8111-111111111111',ID='22222222-2222-4222-8222-222222222222',VIDEO='33333333-3333-4333-8333-333333333333',SECOND='44444444-4444-4444-8444-444444444444',THIRD='55555555-5555-4555-8555-555555555555';
const CREATED=Date.parse('2026-11-20T13:00:00Z'),CURSOR=CREATED+'.'+ID,NEXT_CURSOR=(CREATED+1)+'.'+SECOND;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const pause=()=>new Promise(resolve=>setTimeout(resolve,15));
async function waitFor(check){for(let n=0;n<200;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Account service UI did not settle');}
const deletion=(overrides={})=>({id:ID,type:'account-deletion',status:'pending',createdAt:CREATED,replayed:false,acknowledgement:'Je verwijderverzoek is ontvangen.',actionPerformed:false,userId:USER,displayName:'Testgebruiker',email:'test@example.invalid',reason:null,details:'',...overrides});
const report=(overrides={})=>deletion({id:SECOND,type:'video-report',jobId:VIDEO,reason:'unsafe',details:'De inhoud moet worden bekeken.',acknowledgement:'Je melding is ontvangen.',...overrides});
const index=(requests=[deletion()],overrides={})=>({requests,limit:50,nextCursor:null,...overrides});

function fixture({handler,native=true,active=true}={}){
 const dom=new JSDOM('<button id="authLogout">Afmelden</button><section id="admin"></section>',{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),win=dom.window,d=win.document,calls=[],verifications=[];let live=active;
 win.rigNativeSite=native;win.rigSessionActive=()=>live;
 win.rigOwnerVerification={async prepare(...args){verifications.push(args);assert.fail('A request queue must not start an owner mutation');}};
 win.rigRequest=async(path,init={})=>{calls.push([path,init]);return handler?handler(path,init,calls):Response.json(index());};
 win.eval(script);const root=d.getElementById('admin');win.rigOwnerAdministration?.mount(root);
 return {dom,win,d,root,calls,verifications,stop(){live=false;},close(){win.rigOwnerAdministration?.dispose();win.close();}};
}
const details=f=>f.d.getElementById('ownerAccountServices');
const status=f=>details(f)?.querySelector('.finance-status');
const refresh=f=>f.d.querySelector('[data-service-refresh]');
const next=f=>f.d.querySelector('[data-service-next]');
const previous=f=>f.d.querySelector('[data-service-previous]');
function open(f){const node=details(f);assert.ok(node);node.open=true;return node;}
async function loaded(f){await waitFor(()=>status(f)?.textContent.startsWith('Bijgewerkt.'));}
async function settled(f,count){await waitFor(()=>f.calls.length===count&&refresh(f)?.disabled===false);}

test('account and video requests load only when their owner disclosure opens and expose receipt-only follow-up',async()=>{
 const f=fixture();try{
  assert.equal(details(f).open,false);await pause();assert.equal(f.calls.length,0);assert.equal(f.root.querySelectorAll(':scope > details').length,4);
  open(f);await loaded(f);assert.deepEqual(f.calls.map(([path])=>path),['/api/owner/account-service-requests']);assert.equal(f.calls[0][1].cache,'no-store');
  const row=f.d.querySelector('[data-account-service-request]');assert.equal(row.dataset.accountServiceRequest,ID);assert.match(row.textContent,/Accountverwijdering aangevraagd/);assert.match(row.textContent,/Testgebruiker/);assert.match(row.textContent,/test@example.invalid/);assert.match(row.textContent,new RegExp(USER));assert.match(row.textContent,/nog geen gegevens verwijderd, terugbetaling uitgevoerd of account afgesloten/);
  assert.equal(previous(f).disabled,true);assert.equal(next(f).disabled,true);assert.equal(row.querySelectorAll('button,form,a[href]').length,0);assert.equal(f.verifications.length,0);
  details(f).open=false;details(f).open=true;details(f).dispatchEvent(new f.win.Event('toggle'));await pause();assert.equal(f.calls.length,1);
 }finally{f.close();}
 for(const options of [{native:false},{active:false}]){const f=fixture(options);try{assert.equal(f.root.children.length,0);assert.equal(f.calls.length,0);}finally{f.close();}}
});

test('video requests show their actual job and reason, Brussels time and missing-profile fallback',async()=>{
 const f=fixture({handler:()=>Response.json(index([report({displayName:null,email:null})]))});try{
  open(f);await loaded(f);const row=f.d.querySelector('[data-account-service-request]');assert.match(row.textContent,/Video gemeld/);assert.match(row.textContent,new RegExp('Video: '+VIDEO));assert.match(row.textContent,/Onveilige inhoud/);assert.match(row.textContent,/De inhoud moet worden bekeken/);assert.match(row.textContent,/20\/11\/2026 14:00/);assert.match(row.textContent,/Naam nog niet gedeeld/);assert.doesNotMatch(row.textContent,/undefined|null/);assert.match(status(f).textContent,/oudste open verzoeken staan eerst/);assert.equal(f.calls.every(([,init])=>init.method===undefined),true);
 }finally{f.close();}
});

test('request identities, details, acknowledgements and errors remain inert text',async()=>{
 const attack='<img src=x onerror=steal()>',f=fixture({handler:()=>Response.json(index([report({displayName:attack,email:'<svg onload=steal()>@example.invalid',details:'<script>steal()</script>',acknowledgement:attack})]))});try{
  open(f);await loaded(f);assert.match(f.root.textContent,/<img src=x onerror=steal\(\)>/);assert.match(f.root.textContent,/<svg onload=steal\(\)>/);assert.match(f.root.textContent,/<script>steal\(\)<\/script>/);assert.equal(f.root.querySelectorAll('img,svg,script,iframe,a[href]').length,0);
 }finally{f.close();}
 const failed=fixture({handler:()=>Response.json({error:attack},{status:503})});try{open(failed);await waitFor(()=>status(failed)?.dataset.error==='true');assert.match(status(failed).textContent,/<img/);assert.equal(failed.root.querySelector('img'),null);}finally{failed.close();}
});

test('an empty queue explicitly reports no open requests and offers no invented action',async()=>{
 const f=fixture({handler:()=>Response.json(index([]))});try{
  open(f);await loaded(f);assert.match(f.root.textContent,/Geen open account- of videomeldingen op deze pagina/);assert.equal(f.root.querySelectorAll('[data-account-service-request]').length,0);assert.equal(previous(f).disabled,true);assert.equal(next(f).disabled,true);assert.equal(f.verifications.length,0);
 }finally{f.close();}
});

test('next, previous and refresh use the actual cursor chain and refresh returns to its first page',async()=>{
 const f=fixture({handler:path=>{
  const cursor=new URL(path,'https://rig.example.chatgpt.site').searchParams.get('cursor');
  return Response.json(cursor===NEXT_CURSOR?index([deletion({id:THIRD,displayName:'Derde pagina'})]):cursor===CURSOR?index([deletion({id:SECOND,displayName:'Tweede pagina'})],{nextCursor:NEXT_CURSOR}):index([deletion({displayName:'Eerste pagina'})],{nextCursor:CURSOR}));
 }});try{
  open(f);await loaded(f);next(f).click();await settled(f,2);assert.match(f.root.textContent,/Tweede pagina/);assert.equal(previous(f).disabled,false);assert.equal(next(f).disabled,false);
  assert.equal(f.calls.at(-1)[0],'/api/owner/account-service-requests?cursor='+encodeURIComponent(CURSOR));
  next(f).click();await settled(f,3);assert.match(f.root.textContent,/Derde pagina/);assert.equal(next(f).disabled,true);
  previous(f).click();await settled(f,4);assert.equal(new URL(f.calls.at(-1)[0],'https://rig.test').searchParams.get('cursor'),CURSOR);assert.match(f.root.textContent,/Tweede pagina/);
  previous(f).click();await settled(f,5);assert.equal(f.calls.at(-1)[0],'/api/owner/account-service-requests');assert.equal(previous(f).disabled,true);assert.match(f.root.textContent,/Eerste pagina/);
  next(f).click();await settled(f,6);refresh(f).click();await settled(f,7);assert.equal(f.calls.at(-1)[0],'/api/owner/account-service-requests');assert.equal(previous(f).disabled,true);assert.match(f.root.textContent,/Eerste pagina/);assert.equal(f.calls.every(([,init])=>init.method===undefined),true);
 }finally{f.close();}
});

test('in-flight queue loads disable navigation and ignore repeated refreshes or toggles',async()=>{
 const pending=deferred(),f=fixture({handler:()=>pending.promise});try{
  open(f);await waitFor(()=>f.calls.length===1);assert.equal(refresh(f).disabled,true);assert.equal(next(f).disabled,true);assert.equal(previous(f).disabled,true);
  for(const button of [refresh(f),next(f),previous(f)])button.dispatchEvent(new f.win.Event('click'));details(f).dispatchEvent(new f.win.Event('toggle'));await pause();assert.equal(f.calls.length,1);
  pending.resolve(Response.json(index([])));await loaded(f);assert.equal(refresh(f).disabled,false);
 }finally{f.close();}
});

test('initial failures can be retried and failed pagination preserves the last verified page and cursor',async()=>{
 let fail=true;const f=fixture({handler:path=>fail?Response.json({error:'Tijdelijk niet beschikbaar.'},{status:503}):Response.json(path.includes('?cursor=')?index([report({displayName:'Volgende klant'})]):index([deletion({displayName:'Bewaarde klant'})],{nextCursor:CURSOR}))});try{
  open(f);await waitFor(()=>status(f)?.dataset.error==='true'&&!refresh(f).disabled);assert.equal(f.root.querySelector('[data-account-service-request]'),null);fail=false;refresh(f).click();await settled(f,2);assert.match(f.root.textContent,/Bewaarde klant/);
  fail=true;next(f).click();await settled(f,3);assert.equal(status(f).dataset.error,'true');assert.match(f.root.textContent,/Bewaarde klant/);assert.equal(previous(f).disabled,true);assert.equal(next(f).disabled,false);
  fail=false;next(f).click();await settled(f,4);assert.match(f.root.textContent,/Volgende klant/);assert.equal(previous(f).disabled,false);
  fail=true;refresh(f).click();await settled(f,5);assert.match(f.root.textContent,/Volgende klant/);assert.equal(previous(f).disabled,false);
  fail=false;previous(f).click();await settled(f,6);assert.equal(f.calls.at(-1)[0],'/api/owner/account-service-requests');assert.match(f.root.textContent,/Bewaarde klant/);
 }finally{f.close();}
});

test('malformed queues never render partially verified rows or enable unsafe pagination',async()=>{
 const invalid=[
  index([deletion()],{limit:20}),index(Array.from({length:51},()=>deletion())),index([deletion()],{nextCursor:'https://attacker.invalid/cursor'}),index([deletion()],{nextCursor:'x'.repeat(513)}),
  index([deletion(),report({status:'resolved'})]),index([deletion({actionPerformed:true})]),index([deletion({replayed:'false'})]),index([deletion({userId:'u-'+'-'.repeat(36)})]),
  index([deletion({id:'invalid'})]),index([deletion({createdAt:'2026-11-20'})]),index([deletion({acknowledgement:'x'.repeat(501)})]),index([deletion({displayName:'x'.repeat(121)})]),index([report({details:'x'.repeat(1001)})]),
  index([deletion({jobId:VIDEO})]),index([report({jobId:'invalid'})]),index([report({reason:'unknown'})])
 ];
 for(const value of invalid){const f=fixture({handler:()=>Response.json(value)});try{
  open(f);await waitFor(()=>status(f)?.dataset.error==='true');assert.equal(f.root.querySelectorAll('[data-account-service-request]').length,0);assert.equal(previous(f).disabled,true);assert.equal(next(f).disabled,true);assert.match(status(f).textContent,/kon niet worden gecontroleerd/);
 }finally{f.close();}}
});

test('a repeated pagination cursor cannot replace the last verified page or trap navigation',async()=>{
 let repeat=true;const f=fixture({handler:path=>Response.json(path.includes('?cursor=')?index([report({displayName:'Tweede klant'})],{nextCursor:repeat?CURSOR:null}):index([deletion({displayName:'Eerste klant'})],{nextCursor:CURSOR}))});try{
  open(f);await loaded(f);next(f).click();await settled(f,2);assert.equal(status(f).dataset.error,'true');assert.match(f.root.textContent,/Eerste klant/);assert.doesNotMatch(f.root.textContent,/Tweede klant/);assert.equal(previous(f).disabled,true);assert.equal(next(f).disabled,false);
  repeat=false;next(f).click();await settled(f,3);assert.match(f.root.textContent,/Tweede klant/);assert.equal(previous(f).disabled,false);assert.equal(next(f).disabled,true);
 }finally{f.close();}
});

test('logout or a changed account binding discards late network and JSON queue replies',async()=>{
 for(const phase of ['response','json'])for(const change of ['logout','inactive','request-binding','session-binding']){
  const pending=deferred();let reads=0;const f=fixture({handler:()=>phase==='response'?pending.promise:{ok:true,status:200,async json(){reads++;return pending.promise;}}});try{
   open(f);await waitFor(()=>phase==='response'?f.calls.length===1:reads===1);
   if(change==='logout'){f.d.getElementById('authLogout').click();f.stop();}else if(change==='inactive')f.stop();else if(change==='request-binding')f.win.rigRequest=async()=>Response.json(index());else f.win.rigSessionActive=()=>true;
   const privateData=index([deletion({displayName:'Privé van vorig account'})]);pending.resolve(phase==='response'?Response.json(privateData):privateData);await waitFor(()=>f.root.children.length===0);assert.doesNotMatch(f.root.textContent,/Privé van vorig account/);assert.equal(f.calls.length,1);assert.equal(f.verifications.length,0);
  }finally{f.close();}
 }
});

test('owner authorization failures clear every private administration section',async()=>{
 for(const code of [401,403]){let denied=false;const f=fixture({handler:()=>denied?Response.json({error:'Geen toegang.'},{status:code}):Response.json(index())});try{
  open(f);await loaded(f);assert.match(f.root.textContent,/Testgebruiker/);denied=true;refresh(f).click();await waitFor(()=>f.root.children.length===0);assert.equal(f.calls.length,2);
 }finally{f.close();}}
});

test('cached page transitions retain queue data and a real unload clears all owner data',async()=>{
 const f=fixture();try{
  open(f);await loaded(f);f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:true}));f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow',{persisted:true}));assert.match(f.root.textContent,/Testgebruiker/);assert.equal(f.calls.length,1);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:false}));assert.equal(f.root.children.length,0);
 }finally{f.close();}
});
