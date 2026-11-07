import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createFixtureRouter} from './public-fixture-adapter.mjs';
import {createSupabaseIdentity} from './supabase-identity.mjs';
import {resolveVerifiedAccount} from './identity.mjs';
import {createBrowserAuth} from './browser-auth.mjs';
import {initializeAuthFixture} from './frontend/auth-fixture.mjs';

const projectUrl='https://abcdefghijklmnopqrst.supabase.co',publishableKey='sb_publishable_fixturekey12345';
function dbFixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./public-identity-schema.sql',import.meta.url),'utf8'));
 sqlite.exec('CREATE TABLE demo_balance(user_id TEXT PRIMARY KEY,balance INTEGER NOT NULL)');
 return {sqlite,db:{prepare(sql){return {bind(...values){return {async first(){return sqlite.prepare(sql).get(...values);},async run(){return sqlite.prepare(sql).run(...values);}};}};}}};
}
function page(){return {location:{href:'https://rig.local/',assign(){}},history:{replaceState(){}},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}}};}
function browserClient(token,router,env){
 let signedIn=true;
 const clientFactory=()=>({auth:{getSession:async()=>({data:{session:signedIn?{access_token:token}:null}}),signOut:async()=>{signedIn=false;return {};}}});
 return createBrowserAuth({projectUrl,publishableKey,callbackUrl:'https://rig.local/auth/callback',browser:page(),clientFactory,
   fetcher:(url,init)=>router(new Request(url,init),env)});
}

test('two simulated sessions reach separate balances via SDK verification and real RIG router',async()=>{
 const {sqlite,db}=dbFixture(),first='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const identity={iss:`${projectUrl}/auth/v1`};
 const a=await resolveVerifiedAccount(db,{...identity,sub:first},identity.iss);
 const b=await resolveVerifiedAccount(db,{...identity,sub:second},identity.iss);
 sqlite.prepare('INSERT INTO demo_balance(user_id,balance) VALUES(?,?)').run(a,1250);
 sqlite.prepare('INSERT INTO demo_balance(user_id,balance) VALUES(?,?)').run(b,300);
 const users={'a.b.c':first,'d.e.f':second};let calls=0;
 const authenticate=createSupabaseIdentity({projectUrl,publishableKey,fetcher:async(_url,init)=>{
   calls++;const token=new Headers(init.headers).get('authorization')?.slice(7),id=users[token];
   return id?Response.json({id}):Response.json({msg:'Invalid JWT'},{status:401});
 }});
 const router=createFixtureRouter({authenticate,limit:async()=>true,payment:async(req,_env,user)=>{
   assert.equal(req.headers.get('authorization'),null);assert.equal(req.headers.get('oai-authenticated-user-id'),null);
   const row=sqlite.prepare('SELECT balance FROM demo_balance WHERE user_id=?').get(user);
   return Response.json({balance:row?.balance??0});
 }});
 const env={DB:db,RIG_PUBLIC_AUTH_EXPERIMENT:'local-fixture-only',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:'https://rig.local'};
 const alice=browserClient('a.b.c',router,env),bob=browserClient('d.e.f',router,env);
 assert.equal((await (await alice.api('/api/payments/balance',{headers:{'oai-authenticated-user-id':b}})).json()).balance,1250);
 assert.equal((await (await bob.api('/api/payments/balance',{headers:{'oai-authenticated-user-id':a}})).json()).balance,300);
 const invalid=browserClient('z.y.x',router,env);
 assert.equal((await invalid.api('/api/payments/balance')).status,401);
 const blocked=await router(new Request('https://rig.local/api/payments/create',{method:'POST',headers:{authorization:'Bearer a.b.c'}}),env);
 assert.equal(blocked.status,404);
 assert.equal((await router(new Request('https://rig.local/api/payments/balance',{headers:{authorization:'Bearer a.b.c'}}),{...env,FAL_KEY:'not-a-real-key'})).status,503);
 await alice.signOut();await assert.rejects(alice.api('/api/payments/balance'),/opnieuw/);
 assert.equal((await (await bob.api('/api/payments/balance')).json()).balance,300);
 assert.equal(calls,4);
 sqlite.close();
});

function fakeDocument(){
 const els={};for(const id of ['authStatus','authLogin','authLogout','authBalance'])els[id]={textContent:'',hidden:true,addEventListener(name,fn){this[name]=fn;}};
 return {els,getElementById:id=>els[id]};
}
test('browser screen is disabled by default and does not initialize the provider',async()=>{
 const document=fakeDocument();let called=false;
 await initializeAuthFixture({document,browser:page(),config:{enabled:false},authFactory:()=>{called=true;}});
 assert.equal(called,false);assert.equal(document.els.authLogin.hidden,true);
 assert.equal(document.els.authStatus.textContent,'Deze aanmeldproef staat uit.');
});
test('screen can show a simulated sign-in, private balance, and sign-out',async()=>{
 const document=fakeDocument();let signedIn=false;
 const auth={finishRedirect:async()=>false,currentSession:async()=>signedIn,beginGoogleSignIn:async()=>{signedIn=true;},signOut:async()=>{signedIn=false;},api:async()=>Response.json({balance:1234})};
 await initializeAuthFixture({document,browser:page(),config:{enabled:true},authFactory:()=>auth});
 assert.equal(document.els.authLogin.hidden,false);
 await document.els.authLogin.click();
 // A redirect reloads the app in practice; simulate initialization on return.
 await initializeAuthFixture({document,browser:page(),config:{enabled:true},authFactory:()=>auth});
 assert.equal(document.els.authBalance.hidden,false);
 await document.els.authBalance.click();assert.match(document.els.authStatus.textContent,/12,34/);
 await document.els.authLogout.click();assert.equal(document.els.authBalance.hidden,true);
});
