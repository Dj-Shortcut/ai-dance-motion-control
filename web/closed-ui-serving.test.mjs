import test from 'node:test';
import assert from 'node:assert/strict';
import ingress from './closed-access-ingress.mjs';
import {createBrowserAuth} from './browser-auth.mjs';

function fixture(){let forwarded=0;const env={RIG_CLOSED_INGRESS_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_ACCESS_AUD:'audience-fixture-123',RIG_ACCESS_OWNER_EMAIL:'owner@example.test',RIG_PUBLIC_ORIGIN:'https://rig.local',RIG_AUTH_CONFIG_ENABLED:'yes',RIG_GOOGLE_AUTH_READY:'yes',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixturekey12345',CLOSED_PRIVATE_SERVICE:{async fetch(){forwarded++;return Response.json({ok:true})}}};const ctx={access:{aud:env.RIG_ACCESS_AUD,async getIdentity(){return {email:'owner@example.test'}}}};return {env,ctx,calls:()=>forwarded};}
test('public UI serves pinned public config only when Google is ready',async()=>{
 const f=fixture(),req=path=>new Request(`https://rig.local${path}`);
 assert.equal((await ingress.fetch(req('/'),f.env,{})).status,200);
 assert.equal((await ingress.fetch(req('/api/auth-config'),f.env,{})).status,200);
 const response=await ingress.fetch(req('/'),f.env,f.ctx);assert.equal(response.status,200);
 const page=await response.text();assert.match(page,/RIG/);assert.match(page,/Videogeneratie is nog niet aangesloten/);
 assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 const csp=response.headers.get('content-security-policy');assert.match(csp,/connect-src 'self' https:\/\/abcdefghijklmnopqrst\.supabase\.co/);assert.doesNotMatch(csp,/connect-src[^;]*\*/);
 const config=await (await ingress.fetch(req('/api/auth-config'),f.env,f.ctx)).json();
 assert.deepEqual(config,{enabled:true,projectUrl:f.env.SUPABASE_URL,publishableKey:f.env.SUPABASE_PUBLISHABLE_KEY,callbackUrl:'https://rig.local/auth/callback'});
 assert.equal(f.calls(),0);
 for(const path of ['/auth/callback?code=fixture','/multiuser/style.css','/multiuser/auth-bundle.js','/multiuser/app.js','/multiuser/payments.js'])assert.equal((await ingress.fetch(req(path),f.env,f.ctx)).status,200);
 const fromProvider=new Request('https://rig.local/auth/callback?code=fixture',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
 assert.equal((await ingress.fetch(fromProvider,f.env,f.ctx)).status,200);
 const sharedLink=new Request('https://rig.local/',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
 assert.equal((await ingress.fetch(sharedLink,f.env,f.ctx)).status,200);
 const paymentReturn=new Request('https://rig.local/?payment=return',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
 assert.equal((await ingress.fetch(paymentReturn,f.env,f.ctx)).status,200);
 const unexpectedReturn=new Request('https://rig.local/?payment=return&other=1',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
 assert.equal((await ingress.fetch(unexpectedReturn,f.env,f.ctx)).status,403);
 const iframeReturn=new Request('https://rig.local/?payment=return',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'}});
 assert.equal((await ingress.fetch(iframeReturn,f.env,f.ctx)).status,403);
 const postReturn=new Request('https://rig.local/?payment=return',{method:'POST',headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
 assert.equal((await ingress.fetch(postReturn,f.env,f.ctx)).status,403);
 const embedded=new Request('https://rig.local/',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'}});
 assert.equal((await ingress.fetch(embedded,f.env,f.ctx)).status,403);
 const crossSiteApi=new Request('https://rig.local/api/auth-config',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'cors','sec-fetch-dest':'empty'}});
 assert.equal((await ingress.fetch(crossSiteApi,f.env,f.ctx)).status,403);
 const crossSitePayment=new Request('https://rig.local/api/payments/balance',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
 assert.equal((await ingress.fetch(crossSitePayment,f.env,f.ctx)).status,403);
 assert.equal((await ingress.fetch(req('/multiuser/generation-ui.js'),f.env,f.ctx)).status,200);
 assert.equal((await ingress.fetch(req('/api/auth-config'),{...f.env,RIG_AUTH_CONFIG_ENABLED:'no'},f.ctx)).status,503);
 assert.equal((await ingress.fetch(req('/api/auth-config'),{...f.env,RIG_GOOGLE_AUTH_READY:'no'},f.ctx)).status,503);
 assert.equal((await ingress.fetch(req('/api/auth-config'),{...f.env,SUPABASE_URL:'https://evil.invalid'},f.ctx)).status,503);
 assert.equal((await ingress.fetch(req('/api/auth-config'),{...f.env,SUPABASE_PUBLISHABLE_KEY:'sb_secret_should_not_be_exposed'},f.ctx)).status,503);
});
test('same-origin API requests send the bearer and validate the session',async()=>{
 const calls=[];const browser={location:{href:'https://rig.local/',assign(){}},history:{replaceState(){}},sessionStorage:{getItem(){return null},setItem(){},removeItem(){}}};
 const user='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const auth=createBrowserAuth({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_fixturekey12345',callbackUrl:'https://rig.local/auth/callback',browser,clientFactory:()=>({auth:{getSession:async()=>({data:{session:{access_token:'a.b.c'}}})}}),fetcher:async(url,init)=>{calls.push({url,init});return Response.json(url.endsWith('/api/session')?{userId:user}:{balance:0})}});
 assert.equal((await auth.api('/api/payments/balance',{},user)).status,200);assert.equal(calls.length,2);
 for(const call of calls){assert.equal(call.init.credentials,'same-origin');assert.equal(new Headers(call.init.headers).get('authorization'),'Bearer a.b.c');assert.equal(call.init.redirect,'error');}
});
