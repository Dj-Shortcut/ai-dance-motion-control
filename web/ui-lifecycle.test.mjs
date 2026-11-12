import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareBoundUi} from './frontend/multiuser/ui-auth.mjs';
import {bindSessionGuard} from './frontend/multiuser/session-guard.mjs';
import {prepareGuardedBinding} from './frontend/multiuser/guarded-binding.mjs';
import {createBrowserAuth} from './browser-auth.mjs';
import {createClient} from '@supabase/supabase-js';

const user='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const session=()=>Response.json({userId:user});
const video=()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'video/mp4'}});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
function browser(){
 const created=[],revoked=[],map=new Map();
 const elements={rigStudio:{hidden:false},resultVideo:{hidden:false,src:'old',pause(){},removeAttribute(k){delete this[k]}},export:{hidden:false,href:'old',removeAttribute(k){delete this[k]}}};
 return {created,revoked,elements,document:{getElementById:id=>elements[id]},sessionStorage:{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)},URL:{createObjectURL(){const url=`blob:${created.length}`;created.push(url);return url},revokeObjectURL(url){revoked.push(url)}}};
}
const trialKey='rig-trial-continuation:v1',otherUser='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const memoryStorage=(map=new Map())=>({map,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)});
function trialRecord({createdAt=Date.now(),...changes}={}){
 const crop={x:0,y:0,w:100,h:100};
 return {version:1,token:'trial-marker',createdAt,state:'completed',quoteId:'quote-1',jobId:'job-1',draft:{person:{name:'portrait.jpg',type:'image/jpeg',size:5000000,lastModified:123456},motion:{name:'phone-4k.mp4',type:'video/mp4',size:600000000,lastModified:123456},mode:'motion',editQuality:null,quality:'pro',start:2.5,seconds:18,prompt:'Bewaar mijn hele gekozen scène.',sound:true,steady:false,cleanup:false,frameTime:0,crops:{person:{...crop},motion:{...crop}},mainSelection:null,faceRequired:true,angleCount:2},...changes};
}
const bind=async(b,id=user)=>prepareBoundUi({browser:b,auth:{api:async()=>Response.json({userId:id})}});

test('only validated trial metadata persists across new tabs; pending requests and tokens stay in sessionStorage',async()=>{
 const local=memoryStorage(),first=browser();first.localStorage=local;
 const binding=await bind(first),raw=JSON.stringify(trialRecord());
 binding.scopedStorage.setItem('rig-generation-pending','pending-session-only');binding.scopedStorage.setItem('approvalToken','token-session-only');
 assert.equal(binding.draftStorage.setItem(trialKey,raw),true);
 assert.deepEqual([...local.map.keys()],[`rig-user:${user}:${trialKey}`]);
 assert.equal(local.map.get(`rig-user:${user}:${trialKey}`),raw);assert.equal(binding.scopedStorage.getItem(trialKey),null);
 binding.dispose();assert.equal(local.map.size,1,'ending a page/session preserves only the bounded trial metadata');
 const next=browser();next.localStorage=local;const restored=await bind(next);
 assert.equal(restored.draftStorage.getItem(trialKey),raw);assert.equal(restored.scopedStorage.getItem('rig-generation-pending'),null);assert.equal(restored.scopedStorage.getItem('approvalToken'),null);
 for(const key of ['rig-generation-job','rig-generation-pending','approvalToken','../other-user']){assert.throws(()=>restored.draftStorage.setItem(key,raw),/Alleen proefvervolgmetadata/);assert.throws(()=>restored.draftStorage.getItem(key),/Alleen proefvervolgmetadata/);}
 assert.equal(local.map.size,1);restored.dispose();
});

test('trial storage uses strict account prefixes and stale bindings cannot touch another account or persisted metadata',async()=>{
 const local=memoryStorage(),b=browser();b.localStorage=local;const alice=await bind(b),aliceRaw=JSON.stringify(trialRecord());
 alice.draftStorage.setItem(trialKey,aliceRaw);alice.dispose();const bob=await bind(b,otherUser),bobRaw=JSON.stringify(trialRecord({token:'bob-trial'}));
 assert.equal(bob.draftStorage.getItem(trialKey),null);bob.draftStorage.setItem(trialKey,bobRaw);
 for(const operation of [()=>alice.draftStorage.getItem(trialKey),()=>alice.draftStorage.setItem(trialKey,bobRaw),()=>alice.draftStorage.removeItem(trialKey)])assert.throws(operation,/beëindigd/);
 assert.equal(local.map.get(`rig-user:${user}:${trialKey}`),aliceRaw);assert.equal(local.map.get(`rig-user:${otherUser}:${trialKey}`),bobRaw);
 for(const id of ['u-'+'-'.repeat(36),'u-'+('a'.repeat(35)+':'),user+':different'])await assert.rejects(bind(browser(),id),/gecontroleerd/);
 bob.dispose();
});

test('expired, oversized, media-bearing or credential-field trial records cannot be persisted; full Unicode and free prompts remain valid',async()=>{
 const local=memoryStorage(),b=browser();b.localStorage=local;const binding=await bind(b),key=`rig-user:${user}:${trialKey}`;
 const invalid=[trialRecord({createdAt:Date.now()-86400000}),trialRecord({createdAt:Date.now()+120000}),{...trialRecord(),approvalToken:'never-persist'},'not-json'];
 for(const mutate of [d=>d.draft.mediaBytes='base64',d=>d.draft.personFile={name:'file'},d=>d.draft.mediaUrl='blob:private-media',d=>d.draft.crops.person.w=101,d=>d.draft.angleCount=4]){const value=trialRecord();mutate(value);invalid.push(value);}
 for(const value of invalid){const raw=typeof value==='string'?value:JSON.stringify(value);assert.equal(binding.draftStorage.setItem(trialKey,raw),false);assert.equal(local.map.has(key),false);local.setItem(key,raw);assert.equal(binding.draftStorage.getItem(trialKey),null);assert.equal(local.map.has(key),false);}
 assert.equal(local.map.size,0);
 const unicode=trialRecord();unicode.draft.prompt='界'.repeat(1900);for(const file of [unicode.draft.person,unicode.draft.motion]){file.name='界'.repeat(256);file.type='界'.repeat(100);}const unicodeRaw=JSON.stringify(unicode);assert.ok(unicodeRaw.length<8192&&new TextEncoder().encode(unicodeRaw).byteLength>8192);assert.equal(binding.draftStorage.setItem(trialKey,unicodeRaw),true);assert.equal(binding.draftStorage.getItem(trialKey),unicodeRaw);
 const freePrompt=trialRecord();freePrompt.draft.prompt='Gebruik de stijl van https://example.test/film met een tekstbord Bearer of hope.';const promptRaw=JSON.stringify(freePrompt);assert.equal(binding.draftStorage.setItem(trialKey,promptRaw),true);assert.equal(binding.draftStorage.getItem(trialKey),promptRaw);binding.dispose();
});

test('localStorage denial or quota uses session fallback, while successful migration removes only the legacy trial slot',async()=>{
 for(const failure of ['getter','get','set']){
  const b=browser(),local=memoryStorage();
  if(failure==='getter')Object.defineProperty(b,'localStorage',{get(){throw Error('Storage denied')}});
  else{b.localStorage=local;local[failure==='get'?'getItem':'setItem']=()=>{throw Error('Storage unavailable')};}
  const binding=await bind(b),raw=JSON.stringify(trialRecord());if(failure==='get')assert.equal(binding.draftStorage.getItem(trialKey),null);
  assert.equal(binding.draftStorage.setItem(trialKey,raw),true);assert.equal(binding.draftStorage.getItem(trialKey),raw);assert.equal(binding.scopedStorage.getItem(trialKey),raw);
  binding.dispose();assert.equal(b.sessionStorage.getItem(`rig-user:${user}:${trialKey}`),raw);
 }
 const b=browser();b.localStorage=memoryStorage();const binding=await bind(b),raw=JSON.stringify(trialRecord());
 binding.scopedStorage.setItem(trialKey,raw);binding.scopedStorage.setItem('rig-generation-pending','keep-pending');
 assert.equal(binding.draftStorage.getItem(trialKey),null,'the application deliberately migrates an existing session draft');
 assert.equal(binding.draftStorage.setItem(trialKey,binding.scopedStorage.getItem(trialKey)),true);assert.equal(binding.scopedStorage.getItem(trialKey),null);assert.equal(binding.scopedStorage.getItem('rig-generation-pending'),'keep-pending');binding.dispose();
});
test('an expired local draft cannot erase a still-valid legacy session draft before migration',async()=>{
 const b=browser();b.localStorage=memoryStorage();const binding=await bind(b),valid=JSON.stringify(trialRecord()),key=`rig-user:${user}:${trialKey}`;
 b.localStorage.setItem(key,JSON.stringify(trialRecord({createdAt:Date.now()-86400000})));binding.scopedStorage.setItem(trialKey,valid);
 assert.equal(binding.draftStorage.getItem(trialKey),null);assert.equal(b.localStorage.getItem(key),null);assert.equal(binding.scopedStorage.getItem(trialKey),valid);
 assert.equal(binding.draftStorage.setItem(trialKey,binding.scopedStorage.getItem(trialKey)),true);assert.equal(binding.draftStorage.getItem(trialKey),valid);assert.equal(binding.scopedStorage.getItem(trialKey),null);binding.dispose();
});

test('explicit logout clears only this account trial metadata, while ordinary disposal preserves it',async()=>{
 const b=browser(),local=memoryStorage();b.localStorage=local;const binding=await bind(b),raw=JSON.stringify(trialRecord());
 binding.draftStorage.setItem(trialKey,raw);b.sessionStorage.setItem(`rig-user:${user}:${trialKey}`,raw);
 local.setItem(`rig-user:${otherUser}:${trialKey}`,raw);local.setItem('unrelated-application-setting','keep');binding.scopedStorage.setItem('rig-generation-job','keep-session-job');
 binding.dispose({logout:true});assert.equal(local.getItem(`rig-user:${user}:${trialKey}`),null);assert.equal(b.sessionStorage.getItem(`rig-user:${user}:${trialKey}`),null);assert.equal(local.getItem(`rig-user:${otherUser}:${trialKey}`),raw);assert.equal(local.getItem('unrelated-application-setting'),'keep');assert.equal(b.sessionStorage.getItem(`rig-user:${user}:rig-generation-job`),'keep-session-job');
 const same=await bind(b);same.draftStorage.setItem(trialKey,raw);same.dispose();assert.equal(local.getItem(`rig-user:${user}:${trialKey}`),raw);
});

test('disposing during response wait aborts and never exposes old video',async()=>{
 const gate=deferred(),reached=deferred(),b=browser();let receivedSignal;
 const auth={api:async(path,options)=>{if(path==='/api/session')return session();receivedSignal=options.signal;reached.resolve();return gate.promise;}};
 const binding=await prepareBoundUi({auth,browser:b});const pending=binding.openVideo('/api/generations/old/video');const rejected=assert.rejects(pending);
 await reached.promise;binding.dispose();assert.equal(receivedSignal.aborted,true);gate.resolve(video());await rejected;
 assert.deepEqual(b.created,[]);assert.equal(b.elements.rigStudio.hidden,true);assert.equal(b.elements.resultVideo.src,undefined);assert.equal(b.elements.export.href,undefined);
 await assert.rejects(binding.request('/api/payments/balance'));assert.throws(()=>binding.scopedStorage.getItem('x'));
});

test('disposing during a streaming body cancels it before making an object URL',async()=>{
 const started=deferred();let canceled=false;
 const stream=new ReadableStream({pull(){started.resolve();return new Promise(()=>{});},cancel(){canceled=true;}});
 const b=browser(),binding=await prepareBoundUi({browser:b,auth:{api:async path=>path==='/api/session'?session():new Response(stream,{headers:{'content-type':'video/mp4'}})}});
 const pending=binding.openVideo('/api/generations/old/video'),rejected=assert.rejects(pending);await started.promise;binding.dispose();await rejected;
 assert.equal(canceled,true);assert.deepEqual(b.created,[]);
});

test('newer video supersedes a delayed download and dispose revokes the current blob',async()=>{
 const gate=deferred(),reached=deferred(),b=browser();
 const binding=await prepareBoundUi({browser:b,auth:{api:async path=>{if(path==='/api/session')return session();if(path.includes('/old/')){reached.resolve();return gate.promise;}return video();}}});
 const old=binding.openVideo('/api/generations/old/video'),rejected=assert.rejects(old);await reached.promise;
 assert.equal(await binding.openVideo('/api/generations/new/video'),'blob:0');gate.resolve(video());await rejected;
 assert.deepEqual(b.created,['blob:0']);binding.dispose();assert.deepEqual(b.revoked,['blob:0']);
});

test('real SDK auth events invalidate a pending result on user change but not same-user refresh',async()=>{
 const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const token=id=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.c2ln`;
 const browserState=browser();browserState.location={href:'https://rig.local/',assign(){}};browserState.history={replaceState(){}};
 browserState.sessionStorage.setItem('sb-abcdefghijklmnopqrst-auth-token',JSON.stringify({access_token:token(a),refresh_token:'refresh-a',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:a,aud:'authenticated'}}));
 let client;
 const factory=(url,key,options)=>{client=createClient(url,key,{...options,global:{fetch:async(_url,init)=>{
  if(new URL(String(_url)).pathname==='/auth/v1/logout')return new Response(null,{status:204});
  const bearer=new Headers(init.headers).get('authorization');return Response.json({id:bearer===`Bearer ${token(a)}`?a:b,aud:'authenticated'});
 }}});return client;};
 const gate=deferred(),reached=deferred();
 const auth=createBrowserAuth({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_fixturekey12345',callbackUrl:'https://rig.local/auth/callback',browser:browserState,clientFactory:factory,fetcher:async url=>{
  if(url.endsWith('/api/session'))return session();reached.resolve();return gate.promise;
 }});
 const binding=await prepareBoundUi({auth,browser:browserState});let ended=0;
 const unwatch=await bindSessionGuard({auth,binding,onChanged:()=>{ended++;}});
 await client.auth.setSession({access_token:token(a),refresh_token:'refresh-a-new'});assert.equal(binding.isActive(),true);
 const pending=binding.openVideo('/api/generations/old/video'),rejected=assert.rejects(pending);await reached.promise;
 const switched=await client.auth.setSession({access_token:token(b),refresh_token:'refresh-b'});assert.equal(switched.error,null);assert.equal(switched.data.user.id,b);
 assert.equal(binding.isActive(),false);assert.equal(ended,1);gate.resolve(video());await rejected;
 assert.deepEqual(browserState.created,[]);unwatch.stop();
 const second=await prepareBoundUi({auth,browser:browserState});let signedOut=0;
 const stop=await bindSessionGuard({auth,binding:second,onChanged:()=>{signedOut++;}});
 await auth.signOut();assert.equal(second.isActive(),false);assert.equal(signedOut,1);stop.stop();
});

test('account switch while obtaining server identity discards the late binding',async()=>{
 let subject='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',listener,changes=0,unsubscribed=false;
 const gate=deferred(),reached=deferred(),b=browser();
 const auth={sessionSubject:async()=>subject,watchSession:fn=>{listener=fn;return ()=>{unsubscribed=true;}},api:async()=>{reached.resolve();return gate.promise;}};
 const pending=prepareGuardedBinding({auth,browser:b,onChanged:()=>{changes++;}}),rejected=assert.rejects(pending,/gewijzigd/);
 await reached.promise;subject='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';listener(subject);
 gate.resolve(session());await rejected;
 assert.equal(changes,1);assert.equal(unsubscribed,true);assert.equal(b.elements.rigStudio.hidden,true);assert.deepEqual(b.created,[]);
});
