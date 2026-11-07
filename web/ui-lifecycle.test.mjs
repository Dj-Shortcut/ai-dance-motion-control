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
