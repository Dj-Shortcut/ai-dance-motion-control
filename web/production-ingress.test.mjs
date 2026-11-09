import test from 'node:test';
import assert from 'node:assert/strict';
import relay from './production-ingress.mjs';
import {productionTenantTesting} from './production-tenant.mjs';
import {SITE_HEADER_NAMES,SITES_BODY_MAX} from './sites-bridge-protocol.mjs';
const {BRIDGE_ORIGIN:origin,SITE_ORIGIN:site}=productionTenantTesting;
function fixture({response,limit=true,extra={}}={}){
 const calls=[],limits=[];
 const env={RIG_PRODUCTION_RELAY_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:origin,RIG_PUBLIC_LIMITER:{async limit(data){limits.push(data);return {success:limit};}},CLOSED_VIDEO_SERVICE:{async fetch(req){calls.push(req);return response??Response.json({ok:true},{headers:{'set-cookie':'private=value','access-control-allow-origin':'*','authorization':'Bearer private','x-internal-debug':'private'}});}},...extra};
 return {env,calls,limits,fetch:(path='/api/payments/balance',init={})=>relay.fetch(new Request(origin+path,{...init,headers:{'cf-connecting-ip':'192.0.2.4',[SITE_HEADER_NAMES.signature]:'a'.repeat(64),...init.headers}}),env)};
}
test('production relay forwards signed headers and strips all caller credentials and identities',async()=>{
 const f=fixture(),headers={authorization:'Bearer attacker',cookie:'session=forged','oai-authenticated-user-id':'forged-user','x-rig-user':'another-user','x-rig-expected-user':'another-user','x-custom-secret':'do-not-forward',origin:site,[SITE_HEADER_NAMES.site]:'signed-project',[SITE_HEADER_NAMES.subject]:'b'.repeat(64),[SITE_HEADER_NAMES.nonce]:'c'.repeat(32),[SITE_HEADER_NAMES.time]:String(Date.now()),[SITE_HEADER_NAMES.digest]:'d'.repeat(64),'content-type':'application/json'};
 const res=await f.fetch('/api/payments/create',{method:'POST',headers,body:'{}'});
 assert.equal(res.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,origin+'/api/payments/create');assert.equal(f.calls[0].redirect,'manual');
 for(const key of ['authorization','cookie','oai-authenticated-user-id','x-rig-user','x-rig-expected-user','x-custom-secret','cf-connecting-ip'])assert.equal(f.calls[0].headers.get(key),null,key);
 for(const key of Object.values(SITE_HEADER_NAMES))assert.equal(f.calls[0].headers.get(key),headers[key]??'a'.repeat(64),key);
 assert.equal(f.calls[0].headers.get('origin'),site);assert.equal(await f.calls[0].text(),'{}');assert.deepEqual(f.limits,[{key:'192.0.2.4'}]);
 for(const key of ['set-cookie','access-control-allow-origin','authorization','x-internal-debug'])assert.equal(res.headers.get(key),null,key);
 assert.equal(res.headers.get('cache-control'),'private, no-store');assert.equal(res.headers.get('referrer-policy'),'no-referrer');
});
test('production relay rejects missing signatures, foreign POST origins and unavailable edge limits before private access',async()=>{
 for(const init of [{headers:{[SITE_HEADER_NAMES.signature]:''}},{method:'POST',body:'{}',headers:{origin:'https://evil.invalid'}},{method:'POST',body:'{}',headers:{origin:site,[SITE_HEADER_NAMES.signature]:'bad'}}]){
  const f=fixture(),r=await f.fetch(init.method==='POST'?'/api/payments/create':'/api/payments/balance',init);assert.ok([401,403].includes(r.status));assert.equal(f.calls.length,0);
 }
 for(const extra of [{RIG_PUBLIC_LIMITER:null},{RIG_PUBLIC_LIMITER:{limit:async()=>({success:false})}}]){const f=fixture({extra});assert.ok([429,503].includes((await f.fetch()).status));assert.equal(f.calls.length,0);}
 const f=fixture();assert.equal((await f.fetch('/api/payments/balance',{headers:{'cf-connecting-ip':''}})).status,503);assert.equal(f.calls.length,0);
});
test('production relay refuses secrets and storage in its public deployment',async()=>{
 for(const key of ['DB','PRODUCTION_DB','BUCKET','FAL_KEY','MOLLIE_API_KEY','MOLLIE_LIVE_API_KEY','RIG_MEDIA_SECRET','RIG_PRODUCTION_SITES_BRIDGE_KEY']){
  const f=fixture({extra:{[key]:{private:true}}});assert.equal((await f.fetch()).status,503,key);assert.equal(f.calls.length,0,key);
 }
 const disabled=fixture({extra:{RIG_PRODUCTION_RELAY_ENABLED:'no'}});assert.equal((await disabled.fetch()).status,503);assert.equal(disabled.calls.length,0);
});
test('Mollie webhook reaches only the exact POST endpoint without forwarding a user session',async()=>{
 const f=fixture(),r=await f.fetch('/api/payments/webhook',{method:'POST',body:'id=tr_abcdef1234',headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8',[SITE_HEADER_NAMES.signature]:'',authorization:'Bearer forged',cookie:'session=forged','oai-authenticated-user-id':'forged',origin:'https://api.mollie.com'}});
 assert.equal(r.status,200);assert.equal(f.calls.length,1);assert.equal(await f.calls[0].text(),'id=tr_abcdef1234');assert.deepEqual([...f.calls[0].headers.keys()],['content-type']);assert.equal(f.calls[0].headers.get('content-type'),'application/x-www-form-urlencoded');
 for(const [path,init] of [['/api/payments/webhook',{}],['/api/payments/webhook?x=1',{method:'POST',body:'id=tr_abcdef1234',headers:{'content-type':'application/x-www-form-urlencoded'}}],['/api/payments/webhook',{method:'POST',body:'{}',headers:{'content-type':'application/json'}}]]){
  const denied=fixture(),response=await denied.fetch(path,init);assert.ok([400,404].includes(response.status));assert.equal(denied.calls.length,0);
 }
});
test('declared oversized or malformed request lengths never reach the private service',async()=>{
 for(const [path,max,type] of [['/api/payments/webhook',2048,'application/x-www-form-urlencoded'],['/api/payments/create',8192,'application/json'],['/api/assets',SITES_BODY_MAX,'application/octet-stream']]){
  for(const length of [String(max+1),'-1','1x','9'.repeat(30)]){
   const f=fixture(),r=await f.fetch(path,{method:'POST',headers:{origin:site,'content-type':type,'content-length':length},body:'x'});assert.equal(r.status,413,path+' '+length);assert.equal(f.calls.length,0);
  }
 }
});
test('redirects, unexpected public paths and foreign origins cannot expose private responses',async()=>{
 const f=fixture({response:Response.redirect('https://evil.invalid',302)});assert.equal((await f.fetch()).status,503);assert.equal(f.calls.length,1);
 for(const path of ['/private','/api/payments/balance?wrong=1','//evil.invalid/api/session','/api/payments/webhook/']){const g=fixture();assert.equal((await g.fetch(path)).status,404,path);assert.equal(g.calls.length,0);}
 const g=fixture();assert.equal((await relay.fetch(new Request('https://evil.invalid/api/payments/balance',{headers:{'cf-connecting-ip':'192.0.2.4',[SITE_HEADER_NAMES.signature]:'a'.repeat(64)}}),g.env)).status,404);assert.equal(g.calls.length,0);
});
test('provider capability reads forward only a bounded range and never sessions',async()=>{
 const path='/provider-inputs/'+'e'.repeat(48)+'.'+'a'.repeat(64)+'/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4';
 const f=fixture({response:new Response(new Uint8Array([1,2]),{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-1/8','content-length':'2'}})});
 const r=await f.fetch(path,{headers:{range:'bytes=0-1',authorization:'Bearer forged',cookie:'session=forged',[SITE_HEADER_NAMES.signature]:''}});
 assert.equal(r.status,206);assert.deepEqual([...f.calls[0].headers.entries()],[['range','bytes=0-1']]);assert.equal(r.headers.get('content-range'),'bytes 0-1/8');assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[1,2]);
 const denied=fixture();assert.equal((await denied.fetch(path,{headers:{range:'bytes=0-1,3-4'}})).status,416);assert.equal(denied.calls.length,0);
 const head=fixture({response:new Response(new Uint8Array([1]),{headers:{'content-type':'video/mp4','content-length':'1'}})});const hr=await head.fetch(path,{method:'HEAD'});assert.equal(hr.status,200);assert.equal(await hr.text(),'');
});

test('owner finance transport preserves the signed month but cannot forward caller roles or secrets',async()=>{
 const f=fixture({response:Response.json({owner:true,receiptsCents:1000})});
 const path='/api/owner/finance?month=2026-11';
 const response=await f.fetch(path,{headers:{authorization:'Bearer forged',cookie:'private=forged','x-rig-owner':'yes','x-rig-user':'forged'}});
 assert.equal(response.status,200);assert.equal(f.calls[0].url,origin+path);
 for(const name of ['authorization','cookie','x-rig-owner','x-rig-user'])assert.equal(f.calls[0].headers.get(name),null);
 assert.equal(response.headers.get('cache-control'),'private, no-store');
 for(const deniedPath of ['/api/owner/finance?month=2026-11&role=owner','/api/owner/finance?month=2026-99','/api/owner/finance/expenses']){const denied=fixture();assert.equal((await denied.fetch(deniedPath)).status,404);assert.equal(denied.calls.length,0);}
});
