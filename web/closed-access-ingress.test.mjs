import test from 'node:test';import assert from 'node:assert/strict';import ingress from './closed-access-ingress.mjs';
function fixture(){let called=0,last,limits=0;const env={RIG_CLOSED_INGRESS_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:'https://rig.local',RIG_PUBLIC_LIMITER:{async limit(){limits++;return {success:true}}},CLOSED_PRIVATE_SERVICE:{async fetch(req){called++;last=req;return Response.json({ok:true})}}};return {env,calls:()=>called,limits:()=>limits,last:()=>last}}
const request=(path='/api/session',options={})=>new Request(`https://rig.local${path}`,{...options,headers:{'cf-connecting-ip':'192.0.2.1',...options.headers}});
test('video traffic uses only its private service and never falls back to payments',async()=>{
 const f=fixture(),received=[];
 const token={authorization:'Bearer a.b.c',cookie:'discard=1','oai-authenticated-user-id':'forged','x-rig-gateway-user':'forged'};
 assert.equal((await ingress.fetch(request('/api/video-config',{headers:token}),f.env)).status,503);
 f.env.CLOSED_VIDEO_SERVICE={async fetch(req){received.push(req);return Response.json({enabled:false})}};
 assert.equal((await ingress.fetch(request('/api/video-config'),f.env)).status,401);
 assert.equal(received.length,0);
 const response=await ingress.fetch(request('/api/video-config',{headers:token}),f.env);
 assert.deepEqual(await response.json(),{enabled:false});assert.equal(received.length,1);
 assert.equal(received[0].headers.get('authorization'),'Bearer a.b.c');
 for(const key of ['cookie','oai-authenticated-user-id','x-rig-gateway-user'])assert.equal(received[0].headers.get(key),null);
 assert.equal(f.calls(),0);
 const crossSite=request('/api/assets',{method:'POST',headers:{...token,origin:'https://rig.local','sec-fetch-site':'cross-site'},body:'media'});
 assert.equal((await ingress.fetch(crossSite,f.env)).status,403);assert.equal(received.length,1);
 f.env.CLOSED_VIDEO_SERVICE={async fetch(){return new Response(null,{status:503})}};
 assert.equal((await ingress.fetch(request('/api/generations/recent',{headers:token}),f.env)).status,503);
 assert.equal(f.calls(),0);
 assert.equal((await ingress.fetch(request('/api/assets/unreviewed',{headers:token}),f.env)).status,404);
});
test('public ingress is default off, limits attempts and forwards only bearer identity',async()=>{const f=fixture(),req=()=>request('/api/session',{headers:{authorization:'Bearer a.b.c','oai-authenticated-user-id':'owner','x-rig-gateway-user':'owner',cookie:'bad=1'}});assert.equal((await ingress.fetch(req(),{...f.env,RIG_CLOSED_INGRESS_ENABLED:'no'})).status,403);assert.equal((await ingress.fetch(req(),f.env)).status,200);assert.equal(f.calls(),1);assert.equal(f.last().headers.get('authorization'),'Bearer a.b.c');assert.equal(f.last().headers.get('cookie'),null);assert.equal(f.last().headers.get('oai-authenticated-user-id'),null);assert.equal(f.last().headers.get('x-rig-gateway-user'),null);assert.equal(f.limits(),1)});
test('private routes reject missing token, limiter, disallowed origins and webhook',async()=>{const f=fixture();assert.equal((await ingress.fetch(request(),f.env)).status,401);assert.equal(f.calls(),0);for(const env of [{...f.env,RIG_MODE:'live'},{...f.env,FAL_KEY:'not-real'},{...f.env,MOLLIE_API_KEY:'test_fixture'}])assert.equal((await ingress.fetch(request(),env)).status,403);assert.equal((await ingress.fetch(request(),{...f.env,RIG_PUBLIC_LIMITER:undefined})).status,503);assert.equal((await ingress.fetch(request(),{...f.env,RIG_PUBLIC_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal((await ingress.fetch(request(),{...f.env,RIG_PUBLIC_LIMITER:{limit:async()=>{throw Error()}}})).status,503);assert.equal((await ingress.fetch(new Request('https://other.invalid/api/session'),f.env)).status,403);assert.equal((await ingress.fetch(request('/api/payments/create',{method:'POST',headers:{origin:'https://evil.invalid'}}),f.env)).status,403);assert.equal((await ingress.fetch(request('/api/payments/webhook'),f.env)).status,404);assert.equal((await ingress.fetch(request('/api/generations'),f.env)).status,401);assert.equal(f.calls(),0)});
