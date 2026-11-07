import test from 'node:test';
import assert from 'node:assert/strict';
import relay,{sitesRelayTesting} from './sites-bridge-ingress.mjs';
import {sitesPath} from './sites-bridge-protocol.mjs';
const origin='https://rig-bridge.example.workers.dev',producer='https://rig.example.chatgpt.site';
const id='11111111-1111-4111-8111-111111111111',payload='e'.repeat(180),signature='a'.repeat(64);
const path=`/provider-inputs/${payload}.${signature}/${id}.mp4`;
function fixture(){
 const calls=[];
 const env={RIG_SITES_RELAY_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_SITES_BRIDGE_ORIGIN:origin,RIG_SITES_PRODUCER_ORIGIN:producer,RIG_PUBLIC_LIMITER:{limit:async()=>({success:true})},CLOSED_VIDEO_SERVICE:{async fetch(req){calls.push(req);return new Response(new Uint8Array([0,1,2,3]),{headers:{'content-type':'video/mp4','content-length':'4','accept-ranges':'bytes','cache-control':'public','set-cookie':'secret=must-not-leak','access-control-allow-origin':'*','x-private-key':'must-not-leak','location':'https://private.invalid/'}})}}};
 const request=(value=path,method='GET',extra={})=>new Request(origin+value,{method,headers:{'cf-connecting-ip':'192.0.2.1',...extra}});
 return {env,calls,request};
}
test('anonymous capability GET forwards only the exact URL and one Range, never browser or identity headers',async()=>{
 const f=fixture(),req=f.request(path,'GET',{range:'bytes=0-3',cookie:'owner-cookie',authorization:'Bearer must-not-forward','oai-authenticated-user-id':'forged','x-rig-sites-signature':'forged',origin:producer,'user-agent':'test'}),response=await relay.fetch(req,f.env);
 assert.equal(response.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,req.url);assert.equal(f.calls[0].method,'GET');assert.deepEqual([...f.calls[0].headers],[['range','bytes=0-3']]);
 for(const name of ['set-cookie','access-control-allow-origin','x-private-key','location'])assert.equal(response.headers.get(name),null);
 assert.equal(response.headers.get('content-type'),'video/mp4');assert.equal(response.headers.get('content-length'),'4');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,1,2,3]);
});
test('HEAD preserves bounded media/range response metadata while suppressing and canceling an upstream body',async()=>{
 const f=fixture();let cancelled=false;
 f.env.CLOSED_VIDEO_SERVICE.fetch=async req=>{f.calls.push(req);return new Response(new ReadableStream({cancel(){cancelled=true}}),{status:206,headers:{'content-type':'video/mp4','content-length':'4','content-range':'bytes 8-11/20','accept-ranges':'bytes','retry-after':'2','www-authenticate':'must-not-forward'}})};
 const response=await relay.fetch(f.request(path,'HEAD',{range:'bytes=8-11'}),f.env);assert.equal(response.status,206);assert.equal(response.body,null);assert.equal(response.headers.get('content-range'),'bytes 8-11/20');assert.equal(response.headers.get('content-length'),'4');assert.equal(response.headers.get('retry-after'),'2');assert.equal(response.headers.get('www-authenticate'),null);assert.equal(cancelled,true);assert.deepEqual([...f.calls[0].headers],[['range','bytes=8-11']]);
});
test('invalid capability shapes, queries, methods or origins never reach private storage',async()=>{
 const f=fixture();
 for(const value of [path+'?ignored=1',path+'?',path+'#fragment',path.replace('.mp4','.png'),path.replace(signature,signature.toUpperCase()),path.replace(payload,'e'.repeat(1537)),path.replace(payload,'e'),path.replace('/provider-inputs/','/other-inputs/'),path.replace(id,id.toUpperCase().replace('1','A')),path.replace('.mp4','%2emp4')]){const response=await relay.fetch(f.request(value),f.env);assert.equal(response.status,404,value)}
 assert.equal((await relay.fetch(f.request(path,'POST'),f.env)).status,405);
 assert.equal((await relay.fetch(new Request('https://other.example'+path,{headers:{'cf-connecting-ip':'192.0.2.1'}}),f.env)).status,404);assert.equal(f.calls.length,0);
});
test('single byte-range syntax is bounded; multipart, inverted, empty and body-bearing requests are rejected',async()=>{
 const f=fixture();
 for(const range of ['bytes=2-1','bytes=0-1,2-3','bytes=-0','bytes=-','items=0-1','bytes=0-1234567890123','bytes= 0-1','bytes=0-1\tbad'])assert.equal((await relay.fetch(f.request(path,'GET',{range}),f.env)).status,416,range);
 assert.equal((await relay.fetch(f.request(path,'GET',{'content-length':'1'}),f.env)).status,400);assert.equal(f.calls.length,0);
 for(const range of ['bytes=0-','bytes=0-0','bytes=-1','bytes=8-11'])assert.equal(sitesRelayTesting.validRange(range),true);
});
test('existing edge limiter and secret-free deployment restrictions apply to capability traffic too',async()=>{
 const f=fixture();
 assert.equal((await relay.fetch(f.request(),{...f.env,FAL_KEY:'accidental'})).status,503);
 assert.equal((await relay.fetch(f.request(),{...f.env,RIG_MEDIA_SECRET:'accidental'})).status,503);
 assert.equal((await relay.fetch(f.request(),{...f.env,DB:{}})).status,503);
 assert.equal((await relay.fetch(f.request(),{...f.env,RIG_MODE:'live'})).status,503);
 assert.equal((await relay.fetch(f.request(),{...f.env,RIG_PUBLIC_LIMITER:{limit:async()=>({success:false})}})).status,429);
 assert.equal(f.calls.length,0);
 f.env.CLOSED_VIDEO_SERVICE.fetch=async()=>new Response(null,{status:302,headers:{location:'https://private.invalid/'}});const response=await relay.fetch(f.request(),f.env);assert.equal(response.status,503);assert.equal(response.headers.get('location'),null);
});
test('the signed operator gateway proof is allowlisted for only the one failed job and only POST',()=>{
 const proof='/api/generations/a5db90b7-7558-40bf-a013-2e121d056f2d/verify-gateway';assert.equal(sitesPath(proof,'POST'),true);assert.equal(sitesPath(proof,'GET'),false);assert.equal(sitesPath(proof.replace('a5db90b7','bbbbbbbb'),'POST'),false);assert.equal(sitesPath(proof+'?x=1','POST'),false);
});
