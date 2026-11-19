import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const script=readFileSync(new URL('./frontend/multiuser/owner-administration.js',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const waitFor=async fn=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Users UI did not settle');};
const pause=()=>new Promise(r=>setTimeout(r,15));
const user=(overrides={})=>({id:'u-11111111-1111-4111-8111-111111111111',reference:'RIG-11111111-1111-4111-8111-111111111111',displayName:'Testgebruiker',email:'test@example.invalid',firstSeenAt:Date.parse('2026-11-19T12:34:00Z'),lastActiveAt:Date.parse('2026-11-19T13:20:00Z'),...overrides});
const index=(users=[user()],overrides={})=>({users,nextCursor:null,totalCount:users.length,profileTrackingAvailable:true,...overrides});
function fixture({handler,native=true,active=true}={}){
 const dom=new JSDOM('<button id="authLogout">Afmelden</button><section id="admin"></section>',{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),win=dom.window,d=win.document,calls=[];let live=active;
 win.rigNativeSite=native;win.rigSessionActive=()=>live;win.rigRequest=async(path,init={})=>{calls.push([path,init]);return handler?handler(path,init,calls):Response.json(index());};
 win.eval(script);const root=d.getElementById('admin');win.rigOwnerAdministration?.mount(root);
 return {dom,win,d,root,calls,stop(){live=false;},close(){win.rigOwnerAdministration?.dispose();win.close();}};
}
function open(f){const details=f.d.getElementById('ownerUsers');assert.ok(details);details.open=true;details.dispatchEvent(new f.win.Event('toggle'));return details;}
const status=f=>f.d.getElementById('ownerUsers')?.querySelector('.finance-status');
const refresh=f=>f.d.querySelector('[data-users-refresh]');
const next=f=>f.d.querySelector('[data-users-next]');
const previous=f=>f.d.querySelector('[data-users-previous]');
async function loaded(f){await waitFor(()=>status(f)?.textContent.startsWith('Bijgewerkt.'));}
function search(f,value){const input=f.d.getElementById('ownerUsersSearch');input.value=value;input.form.dispatchEvent(new f.win.Event('submit',{bubbles:true,cancelable:true}));}

test('users remain in a closed finance disclosure and load one owner-only page on opening',async()=>{
 const f=fixture();try{
  assert.equal(f.d.getElementById('ownerUsers').open,false);await pause();assert.equal(f.calls.length,0);assert.equal(f.root.querySelectorAll(':scope > details').length,3);
  open(f);await loaded(f);assert.deepEqual(f.calls.map(([path])=>path),['/api/owner/users?limit=25']);assert.equal(f.calls[0][1].cache,'no-store');assert.equal(f.calls[0][1].method,undefined);assert.match(f.root.textContent,/Testgebruiker/);assert.match(f.root.textContent,/test@example.invalid/);assert.match(f.root.textContent,/1 gebruiker · pagina 1/);assert.equal(previous(f).disabled,true);assert.equal(next(f).disabled,true);
 }finally{f.close();}
 for(const options of [{native:false},{active:false}]){const f=fixture(options);try{assert.equal(f.root.children.length,0);assert.equal(f.calls.length,0);}finally{f.close();}}
});

test('users show Brussels visit and activity times while older accounts retain an honest identity fallback',async()=>{
 const f=fixture({handler:()=>Response.json(index([user(),user({id:'old-account',reference:'RIG-OLD-ACCOUNT',displayName:null,email:null,firstSeenAt:Date.parse('2026-07-01T22:15:00Z'),lastActiveAt:null})]))});try{
  open(f);await loaded(f);const rows=f.d.querySelectorAll('[data-owner-user]');assert.equal(rows.length,2);assert.match(rows[0].textContent,/Eerste bezoek19\/11\/2026 13:34/);assert.match(rows[0].textContent,/Laatst actief19\/11\/2026 14:20/);assert.match(rows[1].textContent,/Naam nog niet gedeeld/);assert.match(rows[1].textContent,/RIG-OLD-ACCOUNT/);assert.match(rows[1].textContent,/02\/07\/2026 00:15/);assert.match(rows[1].textContent,/Laatst actiefNog niet bijgehouden/);assert.match(f.d.getElementById('ownerUsers').textContent,/Bij bestaande accounts.*volgende bezoek/);assert.doesNotMatch(f.d.getElementById('ownerUsers').textContent,/laatste login|laatste aanmelding/i);
 }finally{f.close();}
});

test('untrusted user names, email addresses and references render as text without executable markup',async()=>{
 const f=fixture({handler:()=>Response.json(index([user({displayName:'<img src=x onerror=alert(1)>',email:'<svg onload=steal()>@example.invalid',reference:'<script>steal()</script>'})]))});try{
  open(f);await loaded(f);assert.match(f.root.textContent,/<img src=x onerror=alert\(1\)>/);assert.match(f.root.textContent,/<svg onload=steal\(\)>/);assert.match(f.root.textContent,/<script>steal\(\)<\/script>/);assert.equal(f.root.querySelectorAll('img,svg,script,iframe,a[href]').length,0);
 }finally{f.close();}
});

test('empty users and empty search results are explicit without invented identity or activity',async()=>{
 const f=fixture({handler:()=>Response.json(index([]))});try{
  open(f);await loaded(f);assert.match(f.root.textContent,/0 gebruikers · pagina 1/);assert.match(f.root.textContent,/Nog geen gebruikers gevonden/);assert.equal(f.d.querySelectorAll('[data-owner-user]').length,0);
  search(f,'geen resultaat');await waitFor(()=>f.calls.length===2&&!refresh(f).disabled);assert.match(f.root.textContent,/Geen gebruikers gevonden voor deze zoekopdracht/);assert.equal(next(f).disabled,true);
 }finally{f.close();}
});

test('search is bounded and URL encoded with a fixed page size and no request for overlong input',async()=>{
 const f=fixture();try{
  open(f);await loaded(f);assert.equal(f.d.getElementById('ownerUsersSearch').maxLength,100);search(f,'  A&B + <naam>  ');await waitFor(()=>f.calls.length===2&&!refresh(f).disabled);
  const url=new URL(f.calls.at(-1)[0],'https://rig.example.chatgpt.site');assert.equal(url.pathname,'/api/owner/users');assert.equal(url.searchParams.get('q'),'A&B + <naam>');assert.equal(url.searchParams.get('limit'),'25');assert.equal(url.searchParams.get('cursor'),null);assert.match(f.root.textContent,/voor “A&B \+ <naam>”/);assert.equal(f.root.querySelector('naam'),null);
  search(f,'x'.repeat(101));await pause();assert.equal(f.calls.length,2);assert.match(status(f).textContent,/maximaal 100 tekens/);
 }finally{f.close();}
});

test('next, previous and refresh use real cursor requests and refresh returns to the first searched page',async()=>{
 const cursor='signed+/=cursor',f=fixture({handler:path=>{const q=new URL(path,'https://rig.example.chatgpt.site').searchParams;return Response.json(q.has('cursor')?index([user({displayName:'Tweede pagina'})],{totalCount:26}):index([user({displayName:'Eerste pagina'})],{nextCursor:cursor,totalCount:26}));}});try{
  open(f);await loaded(f);search(f,'Test');await waitFor(()=>f.calls.length===2&&!refresh(f).disabled);next(f).click();await waitFor(()=>f.calls.length===3&&!refresh(f).disabled);assert.match(f.root.textContent,/Tweede pagina/);assert.match(f.root.textContent,/pagina 2/);assert.equal(previous(f).disabled,false);assert.equal(next(f).disabled,true);
  let query=new URL(f.calls.at(-1)[0],'https://rig.example.chatgpt.site').searchParams;assert.equal(query.get('cursor'),cursor);assert.equal(query.get('q'),'Test');assert.equal(query.get('limit'),'25');
  previous(f).click();await waitFor(()=>f.calls.length===4&&!refresh(f).disabled);assert.match(f.root.textContent,/Eerste pagina/);assert.equal(previous(f).disabled,true);assert.equal(new URL(f.calls.at(-1)[0],'https://rig.example.chatgpt.site').searchParams.has('cursor'),false);
  next(f).click();await waitFor(()=>f.calls.length===5&&!refresh(f).disabled);refresh(f).click();await waitFor(()=>f.calls.length===6&&!refresh(f).disabled);query=new URL(f.calls.at(-1)[0],'https://rig.example.chatgpt.site').searchParams;assert.equal(query.get('q'),'Test');assert.equal(query.has('cursor'),false);assert.match(f.root.textContent,/pagina 1/);assert.equal(previous(f).disabled,true);assert.equal(f.calls.every(([,init])=>init.method===undefined),true);
 }finally{f.close();}
});

test('refresh and pagination failures retain the last page and let the owner retry',async()=>{
 let failed=false;const f=fixture({handler:path=>failed?Response.json({error:'Tijdelijk niet beschikbaar.'},{status:503}):Response.json(index([user({displayName:path.includes('cursor=')?'Tweede pagina':'Bewaarde gebruiker'})],{nextCursor:path.includes('cursor=')?null:'next',totalCount:26}))});try{
  open(f);await loaded(f);failed=true;refresh(f).click();await waitFor(()=>status(f).dataset.error==='true'&&!refresh(f).disabled);assert.match(f.root.textContent,/Bewaarde gebruiker/);assert.match(status(f).textContent,/eerder opgehaalde gegevens blijven staan/);assert.equal(next(f).disabled,false);
  next(f).click();await waitFor(()=>f.calls.length===3&&!refresh(f).disabled);assert.match(f.root.textContent,/pagina 1/);assert.equal(previous(f).disabled,true);assert.equal(next(f).disabled,false);failed=false;next(f).click();await waitFor(()=>f.calls.length===4&&!refresh(f).disabled);assert.match(f.root.textContent,/Tweede pagina/);assert.match(f.root.textContent,/pagina 2/);
 }finally{f.close();}
});

test('invalid user indexes do not expose unverified rows or enable unsafe pagination',async()=>{
 for(const value of [index([user()],{profileTrackingAvailable:false}),index([user()],{nextCursor:'x'.repeat(513)}),index(Array.from({length:26},()=>user())),index([user({lastActiveAt:'2026-11-19'})]),index([user({firstSeenAt:null})])]){
  const f=fixture({handler:()=>Response.json(value)});try{open(f);await waitFor(()=>status(f).dataset.error==='true');assert.equal(f.d.querySelectorAll('[data-owner-user]').length,0);assert.equal(next(f).disabled,true);assert.equal(previous(f).disabled,true);assert.match(status(f).textContent,/kon niet worden gecontroleerd/);}finally{f.close();}
 }
});

test('an older users search response cannot replace the latest results',async()=>{
 const old=deferred(),f=fixture({handler:path=>path.includes('q=oud')?old.promise:Response.json(index([user({displayName:path.includes('q=nieuw')?'Nieuwe resultaten':'Eerste resultaten'})]))});try{
  open(f);await loaded(f);search(f,'oud');await waitFor(()=>f.calls.length===2);search(f,'nieuw');await waitFor(()=>f.calls.length===3&&!refresh(f).disabled);assert.match(f.root.textContent,/Nieuwe resultaten/);
  old.resolve(Response.json(index([user({displayName:'Verouderde resultaten'})])));await pause();assert.match(f.root.textContent,/Nieuwe resultaten/);assert.doesNotMatch(f.root.textContent,/Verouderde resultaten|voor “oud”/);
 }finally{f.close();}
});

test('logout, session loss and changed account bindings isolate late user responses, including delayed JSON reads',async()=>{
 for(const change of ['logout','inactive','request-binding','session-binding']){
  const late=deferred();let reads=0;const f=fixture({handler:()=>({ok:true,status:200,async json(){reads++;return late.promise;}})});try{
   open(f);await waitFor(()=>reads===1);if(change==='logout'){f.d.getElementById('authLogout').click();f.stop();}else if(change==='inactive')f.stop();else if(change==='request-binding')f.win.rigRequest=async()=>Response.json(index());else f.win.rigSessionActive=()=>true;
   late.resolve(index([user({displayName:'Privé van vorig account'})]));await waitFor(()=>f.root.children.length===0);assert.doesNotMatch(f.root.textContent,/Privé van vorig account/);assert.equal(f.calls.length,1);
  }finally{f.close();}
 }
});

test('owner authorization failures clear every private administration section',async()=>{
 for(const code of [401,403]){let denied=false;const f=fixture({handler:()=>denied?Response.json({error:'Geen toegang.'},{status:code}):Response.json(index())});try{
  open(f);await loaded(f);assert.match(f.root.textContent,/Testgebruiker/);denied=true;refresh(f).click();await waitFor(()=>f.root.children.length===0);assert.equal(f.calls.length,2);
 }finally{f.close();}}
});

test('cached page transitions retain user results without new requests and a real unload clears them',async()=>{
 const f=fixture();try{
  open(f);await loaded(f);const before=f.calls.length;f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:true}));f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow',{persisted:true}));assert.match(f.root.textContent,/Testgebruiker/);assert.equal(f.calls.length,before);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:false}));assert.equal(f.root.children.length,0);
 }finally{f.close();}
});
