import test from 'node:test';
import assert from 'node:assert/strict';
import {createClosedVideoWorker} from './closed-video-worker.mjs';

const origin='https://rig.local',project='https://abcdefghijklmnopqrst.supabase.co';
const owner='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture(price=async()=>({provider:'fal',currency:'USD',unit:'second',prices:{standard:0.06,pro:0.11}})){
 let received=[],calls=[],priceCalls=0,tenant={mode:'test',environment_id:'closed-test-1',public_origin:origin,identity_project:project},lockSchema=true;
 const DB={batch(){},prepare(sql){return {bind(...args){return {first:async()=>{if(sql.includes('rig_external_identities'))return args[0]===`${project}/auth/v1`&&args[1]===owner?{found:1}:null;if(sql.includes('rig_rate_limits'))return {requests:1};throw Error('unexpected bind')}}},async first(){if(sql.includes('rig_closed_test_tenant'))return tenant;if(sql.includes('rig_payment_environment'))return {mode:'test'};if(sql.includes('rig_media_work_lock')){if(!lockSchema)throw Error('missing migration');return null}throw Error('unexpected query')}}}};
 const env={RIG_CLOSED_VIDEO_ENABLED:'yes',RIG_VIDEO_PRIVATE_SERVICE_ONLY:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:origin,RIG_TEST_ENVIRONMENT_ID:'closed-test-1',SUPABASE_URL:project,RIG_VIDEO_OWNER_USER_ID:owner,RIG_MEDIA_SECRET:'x'.repeat(40),FAL_KEY:'fixture',RIG_PRICE_STANDARD:'25',RIG_PRICE_PRO:'30',RIG_PRICE_VERSION:'fixture-1',RIG_CLOSED_VIDEO_MAX_CENTS:'300',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'500000',DB,BUCKET:{get(){},put(){},head(){}},RIG_MEDIA:{fetch(){}},CLOSED_IDENTITY_SERVICE:{async fetch(req){received.push(req);const token=req.headers.get('authorization');return token==='Bearer a.b.c'?Response.json({userId:owner}):token==='Bearer d.e.f'?Response.json({userId:other}):new Response(null,{status:401})}}};
 const worker=createClosedVideoWorker({pricePreflight:async(...args)=>{priceCalls++;return price(...args)},leaseFactory:()=>({acquire(){},complete(){}}),serviceFactory:async(_env,opts)=>{calls.push(opts);return async()=>Response.json({ok:true})}});
 return {env,worker,received,calls,priceCalls:()=>priceCalls,setTenant:x=>tenant=x,missingLock:()=>{lockSchema=false}};
}
function request(path,token='a.b.c',options={}){return new Request(`${origin}${path}`,{...options,headers:{authorization:`Bearer ${token}`,...options.headers}})}
test('only server-verified owner can enable and use the private video routes',async()=>{
 const f=fixture();
 assert.deepEqual(await (await f.worker.fetch(request('/api/video-config'),f.env)).json(),{enabled:true,funding:'owner'});
 assert.deepEqual(await (await f.worker.fetch(request('/api/video-config','d.e.f',{headers:{'oai-authenticated-user-id':owner,'x-rig-gateway-user':owner}}),f.env)).json(),{enabled:false});
 assert.equal((await f.worker.fetch(request('/api/generations','d.e.f',{headers:{'oai-authenticated-user-id':owner}}),f.env)).status,503);
 assert.equal((await f.worker.fetch(request('/api/video-config','z.y.x'),f.env)).status,401);
 assert.equal((await f.worker.fetch(request('/api/generations'),f.env)).status,200);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].trustedUserId,owner);
 for(const req of f.received){assert.equal(new URL(req.url).pathname,'/api/session');assert.equal(req.headers.get('oai-authenticated-user-id'),null);assert.equal(req.headers.get('x-rig-gateway-user'),null);assert.equal(req.headers.get('cookie'),null)}
});
test('flags, owner mapping, tenant and schema all fail closed',async()=>{
 for(const patch of [{RIG_CLOSED_VIDEO_ENABLED:'no'},{RIG_VIDEO_PRIVATE_SERVICE_ONLY:'no'},{RIG_MODE:'live'},{RIG_VIDEO_OWNER_USER_ID:other},{RIG_TEST_ENVIRONMENT_ID:'different-env'},{FAL_KEY:''},{RIG_MEDIA_SECRET:''},{RIG_PRICE_PRO:''},{MOLLIE_API_KEY:'test_fixture'},{RIG_STAGING_OWNER:'owner'}]){const f=fixture();assert.deepEqual(await (await f.worker.fetch(request('/api/video-config'),{...f.env,...patch})).json(),{enabled:false});assert.equal(f.calls.length,0)}
 const f=fixture();f.setTenant({mode:'test',environment_id:'closed-test-1',public_origin:origin,identity_project:'https://wrong.invalid'});assert.deepEqual(await (await f.worker.fetch(request('/api/video-config'),f.env)).json(),{enabled:false});
 const g=fixture();g.missingLock();assert.deepEqual(await (await g.worker.fetch(request('/api/video-config'),g.env)).json(),{enabled:false});
});
test('estimate is owner-only, bounded and clearly non-binding',async()=>{
 const f=fixture();const r=await f.worker.fetch(request('/api/estimate/fal?quality=pro&duration=4'),f.env);assert.equal(r.status,200);const body=await r.json();assert.equal(body.providerEstimate.usdMicros,440000);assert.equal(body.providerEstimate.rateUsdMicrosPerSecond,110000);assert.match(body.providerEstimate.rateCheckedOn,/^\d{4}-\d{2}-\d{2}$/);assert.equal(body.providerEstimate.binding,false);assert.equal(body.customerProposal.priceCents,120);assert.equal(body.customerProposal.binding,false);assert.equal(body.customerProposal.testOnly,true);assert.equal(f.priceCalls(),1);
 assert.equal((await f.worker.fetch(request('/api/estimate/fal?quality=pro&duration=4','d.e.f'),f.env)).status,503);
 assert.equal((await f.worker.fetch(request('/api/assets','a.b.c',{method:'POST',headers:{origin:'https://evil.invalid'}}),f.env)).status,403);
 assert.equal((await f.worker.fetch(request('/api/payments/create','a.b.c',{method:'POST',headers:{origin}}),f.env)).status,404);
});
test('invalid requests and other accounts cannot call the provider',async()=>{
 const f=fixture();
 for(const path of ['/api/estimate/fal?quality=pro&duration=2','/api/estimate/fal?quality=pro&duration=31','/api/estimate/fal?quality=pro&duration=4&duration=5','/api/estimate/fal?quality=bad&duration=4','/api/estimate/fal?quality=pro&duration=4&other=1'])assert.equal((await f.worker.fetch(request(path),f.env)).status,400);
 assert.equal((await f.worker.fetch(request('/api/estimate/fal?quality=pro&duration=4','d.e.f'),f.env)).status,503);
 assert.equal((await f.worker.fetch(request('/api/estimate/fal?quality=pro&duration=4','a.b.c',{method:'POST',headers:{origin}}),f.env)).status,405);
 assert.equal(f.priceCalls(),0);
});
test('30-second owner estimate uses expanded bounds without exceeding them',async()=>{
 const f=fixture(),env={...f.env,RIG_PRICE_PRO:'25',RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000'};
 const response=await f.worker.fetch(request('/api/estimate/fal?quality=pro&duration=30'),env);assert.equal(response.status,200);const body=await response.json();assert.equal(body.customerProposal.priceCents,750);assert.equal(body.providerEstimate.usdMicros,3300000);assert.equal(body.billedSeconds,30);
 assert.equal((await f.worker.fetch(request('/api/estimate/fal?quality=pro&duration=30.001'),env)).status,400);
});
test('O3 estimates and capability are disabled unless both an explicit flag and valid price are configured',async()=>{
 for(const patch of [{},{RIG_PRICE_EDIT:'20'},{RIG_EDIT_ENABLED:'yes'},{RIG_EDIT_ENABLED:'yes',RIG_PRICE_EDIT:'0'},{RIG_EDIT_ENABLED:'yes',RIG_PRICE_EDIT:'251'},{RIG_EDIT_ENABLED:'yes',RIG_PRICE_EDIT:20}]){
  const f=fixture(),env={...f.env,...patch};assert.equal((await f.worker.fetch(request('/api/estimate/fal?quality=edit-standard&duration=5'),env)).status,400);assert.equal(f.priceCalls(),0);
  assert.deepEqual(await (await f.worker.fetch(request('/api/video-config'),env)).json(),{enabled:true,funding:'owner'});
 }
});
test('O3 estimate uses only the current exact model price and configured eurocent rate with a 15-second maximum',async()=>{
 const f=fixture(async(key,transport,options)=>{assert.equal(key,'fixture');assert.equal(typeof transport,'function');assert.deepEqual(options,{includeEdit:true});return {provider:'fal',currency:'USD',unit:'second',prices:{standard:0.06,pro:0.11,'edit-standard':0.14}}});
 const env={...f.env,RIG_EDIT_ENABLED:'yes',RIG_PRICE_EDIT:'20',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000'};
 assert.deepEqual(await (await f.worker.fetch(request('/api/video-config'),env)).json(),{enabled:true,funding:'owner',qualities:['standard','pro','edit-standard']});
 let r=await f.worker.fetch(request('/api/estimate/fal?quality=edit-standard&duration=5'),env);assert.equal(r.status,200);let b=await r.json();assert.equal(b.customerProposal.priceCents,100);assert.equal(b.customerProposal.testOnly,true);assert.equal(b.customerProposal.binding,false);assert.equal(b.providerEstimate.usdMicros,700000);assert.equal(b.providerEstimate.rateUsdMicrosPerSecond,140000);assert.equal(b.providerEstimate.binding,false);
 r=await f.worker.fetch(request('/api/estimate/fal?quality=edit-standard&duration=15'),env);assert.equal(r.status,200);b=await r.json();assert.equal(b.customerProposal.priceCents,300);assert.equal(b.providerEstimate.usdMicros,2100000);
 const before=f.priceCalls();for(const duration of ['2.999','15.001','30'])assert.equal((await f.worker.fetch(request('/api/estimate/fal?quality=edit-standard&duration='+duration),env)).status,400);assert.equal(f.priceCalls(),before);
});
test('O3 estimate never falls back to another model or a stale rate when live pricing is missing or over budget',async()=>{
 for(const prices of [{standard:0.01,pro:0.02},{'edit-standard':null},{'edit-standard':0},{'edit-standard':NaN},{'edit-standard':0.2}]){
  const f=fixture(async()=>({provider:'fal',currency:'USD',unit:'second',prices})),env={...f.env,RIG_EDIT_ENABLED:'yes',RIG_PRICE_EDIT:'20'};
  assert.equal((await f.worker.fetch(request('/api/estimate/fal?quality=edit-standard&duration=5'),env)).status,503);assert.equal(f.priceCalls(),1);
 }
});
test('sponsor routes stay disabled by default and reject a mismatched tenant before handling codes',async()=>{
 const f=fixture(),post={method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({code:'A'.repeat(43)})};
 assert.equal((await f.worker.fetch(request('/api/sponsor-invitations/redeem','d.e.f',post),f.env)).status,503);
 f.setTenant({mode:'test',environment_id:'closed-test-1',public_origin:origin,identity_project:'https://wrong.invalid'});
 assert.equal((await f.worker.fetch(request('/api/sponsor-invitations/redeem','d.e.f',post),{...f.env,RIG_SPONSORED_ENABLED:'yes'})).status,503);
 assert.equal((await f.worker.fetch(request('/api/sponsor-invitations/redeem','d.e.f',{...post,headers:{...post.headers,origin:'https://evil.invalid'}}),{...f.env,RIG_SPONSORED_ENABLED:'yes'})).status,403);
 assert.equal(f.priceCalls(),0);assert.equal(f.calls.length,0);
});
test('provider errors, bad rates and over-cap estimates fail closed without leaking details',async()=>{
 for(const price of [async()=>{throw Error('private-provider-detail')},async()=>({provider:'fal',currency:'EUR',unit:'second',prices:{pro:0.1}}),async()=>({provider:'fal',currency:'USD',unit:'second',prices:{pro:NaN}}),async()=>({provider:'fal',currency:'USD',unit:'second',prices:{pro:0}}),async()=>({provider:'fal',currency:'USD',unit:'second',prices:{pro:0.2}})]){
  const f=fixture(price),response=await f.worker.fetch(request('/api/estimate/fal?quality=pro&duration=4'),f.env);assert.equal(response.status,503);const body=await response.text();assert.doesNotMatch(body,/private-provider-detail|fixture/);
 }
});
