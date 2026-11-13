import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';import {verifyGateway,createStageGateway,gatewayTesting,cleanupExpiredNonces} from './gateway.mjs';import stage,{stagingTesting} from './staging.mjs';
const origin='https://rig.example',key='ab'.repeat(32),now=Date.now();let next=0;
function db(){let sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./gateway-schema.sql',import.meta.url),'utf8'));sql.exec(readFileSync(new URL('./staging-schema.sql',import.meta.url),'utf8'));for(const name of ['schema.sql','generation-schema.sql','limit-schema.sql'])sql.exec(readFileSync(new URL('./'+name,import.meta.url),'utf8'));sql.exec("INSERT INTO rig_payment_environment(id,mode) VALUES(1,'test')");return {prepare(s){let args=[];return{bind(...v){args=v;return this},async run(){return{meta:{changes:Number(sql.prepare(s).run(...args).changes)}}},async first(){return sql.prepare(s).get(...args)??null}}},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results}catch(error){sql.exec('ROLLBACK');throw error}}}}
function env(){return {DB:db(),RIG_MODE:'test',RIG_MOLLIE_MODE:'test',MOLLIE_API_KEY:'test_abc',RIG_GATEWAY_KEY:key,RIG_GATEWAY_CONFIGURED:'yes',RIG_WEBHOOK_PRIVATE_SERVICE_ONLY:'yes',RIG_PUBLIC_ORIGIN:origin,RIG_STAGING_OWNER:'alice',RIG_WEBHOOK_URL:origin+'/api/payments/webhook',RIG_PACKAGES:JSON.stringify([{id:'small',amountCents:500,credits:500}])}}
const enc=new TextEncoder(),hex=x=>Array.from(new Uint8Array(x),b=>b.toString(16).padStart(2,'0')).join('');
async function signed({path='/api/payments/balance',user='alice',method='GET',body='',time=Date.now(),nonce=(++next).toString(16).padStart(32,'0'),headers={}}={}){
 const h=new Headers(headers);let digest=hex(await crypto.subtle.digest('SHA-256',enc.encode(body)));h.set('x-rig-gateway-user',user);h.set('x-rig-gateway-time',String(time));h.set('x-rig-gateway-nonce',nonce);h.set('x-rig-gateway-body-sha256',digest);
 const k=await crypto.subtle.importKey('raw',Uint8Array.from(key.match(/../g),n=>parseInt(n,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);h.set('x-rig-gateway-signature',hex(await crypto.subtle.sign('HMAC',k,enc.encode(gatewayTesting.canonical(method,path,user,String(time),nonce,digest,h)))));
 return new Request(origin+path,{method,headers:h,...(body?{body,duplex:'half'}:{})});
}
test('unconfigured and live keys fail closed',async()=>{assert.equal((await stage.fetch(new Request(origin+'/api/payments/balance'),{})).status,503);let e=env();e.MOLLIE_API_KEY='live_abcd';assert.equal((await stage.fetch(await signed(),e)).status,503)});
test('gateway authenticates HMAC, strips spoofed headers, prevents replay',async()=>{const e=env(),req=await signed({headers:{'oai-authenticated-user-id':'other'}}),clone=req.clone();let result=await verifyGateway(req,e);assert.equal(result.user,'alice');assert.equal(result.request.headers.get('oai-authenticated-user-id'),null);assert.equal(result.request.headers.get('x-rig-gateway-user'),null);assert.equal(await verifyGateway(clone,e),null)});
test('forged identity, body and relevant header cannot be changed',async()=>{let e=env();const req=await signed({path:'/api/assets',method:'POST',body:'asset',headers:{origin,'content-type':'image/png','x-rig-asset-kind':'image'}});let h=new Headers(req.headers);h.set('x-rig-asset-kind','video');assert.equal(await verifyGateway(new Request(req.url,{method:'POST',headers:h,body:'asset',duplex:'half'}),e),null);h=new Headers(req.headers);assert.equal(await verifyGateway(new Request(req.url,{method:'POST',headers:h,body:'changed',duplex:'half'}),e),null);h.set('x-rig-gateway-user','bob');assert.equal(await verifyGateway(new Request(req.url,{method:'POST',headers:h,body:'asset',duplex:'half'}),e),null)});
test('old, unsigned and wrong path requests are rejected',async()=>{let e=env();assert.equal(await verifyGateway(await signed({time:now-120000}),e),null);assert.equal(await verifyGateway(new Request(origin+'/api/payments/balance'),e),null);let req=await signed();assert.equal(await verifyGateway(new Request(origin+'/api/payments/create',{headers:req.headers}),e),null)});
test('owner policy refuses another verified user before routing',async()=>{let e=env();assert.equal((await stage.fetch(await signed({user:'bob'}),e)).status,401)});
test('test webhook is routed separately, subject to provider verification',async()=>{let e=env(),called=0;const h=createStageGateway({route:async(_req,_env,user)=>{called++;assert.equal(user,null);return new Response('ok')}});assert.equal((await h(new Request(origin+'/api/payments/webhook',{method:'POST'}),e)).status,200);assert.equal(called,1)});
test('shared media lease prevents parallel access and releases by owner token',async()=>{let e=env(),a=await stagingTesting.lease(e.DB);assert.ok(a);assert.equal(await stagingTesting.lease(e.DB),null);await stagingTesting.release(e.DB,'other');assert.equal(await stagingTesting.lease(e.DB),null);await stagingTesting.release(e.DB,a);assert.ok(await stagingTesting.lease(e.DB))});

test('cleanup keeps live nonces and removes only expired entries',async()=>{let e=env(),t=Date.now();await e.DB.prepare('INSERT INTO rig_gateway_nonces(nonce,created_at) VALUES(?,?)').bind('old',t-360000).run();await e.DB.prepare('INSERT INTO rig_gateway_nonces(nonce,created_at) VALUES(?,?)').bind('new',t).run();const result=await cleanupExpiredNonces(e.DB,t);assert.equal(result.meta.changes,1);assert.equal(await e.DB.prepare('SELECT nonce FROM rig_gateway_nonces WHERE nonce=?').bind('old').first(),null);assert.equal((await e.DB.prepare('SELECT nonce FROM rig_gateway_nonces WHERE nonce=?').bind('new').first()).nonce,'new')});

test('signed owner can use test-only Mollie route with network fixture',async()=>{const e=env(),old=globalThis.fetch;let invoked=0;globalThis.fetch=async(url,opt)=>{invoked++;assert.equal(url,'https://api.mollie.com/v2/payments');assert.equal(opt.headers.Authorization,'Bearer test_abc');assert.equal(opt.redirect,'manual');const p=JSON.parse(opt.body);assert.equal(p.amount.value,'5.00');return Response.json({id:'tr_AbC1234567',mode:'test',_links:{checkout:{href:'https://www.mollie.com/checkout/test'} }})};try{const request=await signed({path:'/api/payments/create',method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({packageId:'small',requestId:'11111111-1111-4111-8111-111111111111'})});const response=await stage.fetch(request,e);assert.equal(response.status,200);assert.equal((await response.json()).checkoutUrl,'https://www.mollie.com/checkout/test');assert.equal(invoked,1)}finally{globalThis.fetch=old}});
test('authenticated concurrent uploads cannot both enter buffered processing',async()=>{const e=env();let releaseFirst,entered;const enteredPromise=new Promise(r=>entered=r),gate=new Promise(r=>releaseFirst=r);let count=0;const handler=createStageGateway({acquire:stagingTesting.lease,release:stagingTesting.release,route:async(_req,_env,_user,ctx)=>{assert.equal(ctx.mediaLeaseHeld,true);count++;entered();await gate;return new Response('ok')}});const options={path:'/api/assets',method:'POST',body:'asset',headers:{origin,'content-type':'image/png','x-rig-asset-kind':'image'}};const first=handler(await signed(options),e);await enteredPromise;const second=await handler(await signed(options),e);assert.equal(second.status,503);assert.equal(count,1);releaseFirst();assert.equal((await first).status,200);assert.ok(await stagingTesting.lease(e.DB))});
test('stalled payment bodies are canceled instead of holding capacity',async()=>{const {paymentTesting}=await import('./payment.mjs');let cancelled=false;const stream=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){cancelled=true}});const req=new Request(origin+'/api/payments/create',{method:'POST',body:stream,duplex:'half'});await assert.rejects(paymentTesting.boundedText(req,4096,20),/timeout/);assert.equal(cancelled,true)});
test('staging webhook freeze atomically enqueues a previously issued checkout',async()=>{
 const e=env(),old=globalThis.fetch;const payments=new Map();let nextId=1,refunded=false;
 globalThis.fetch=async(url,opt={})=>{const path=url.replace('https://api.mollie.com/v2/','');if(path==='payments'&&opt.method==='POST'){let input=JSON.parse(opt.body),id=`tr_ABCDEF${nextId++}`;payments.set(id,{id,mode:'test',status:'open',metadata:input.metadata,amount:input.amount,_links:{checkout:{href:`https://www.mollie.com/checkout/${id}`}}});return Response.json(payments.get(id))}let match=path.match(/^payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks)\?limit=1)?$/);if(!match||!payments.has(match[1]))return new Response('',{status:404});if(match[2])return Response.json({_embedded:{[match[2]]:match[2]==='refunds'&&refunded?[{id:'re_1'}]:[]}});return Response.json(payments.get(match[1]))};
 try {const create=async id=>stage.fetch(await signed({path:'/api/payments/create',method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({packageId:'small',requestId:id})}),e);
 const hook=async id=>stage.fetch(new Request(origin+'/api/payments/webhook',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id='+id}),e);
 assert.equal((await create('11111111-1111-4111-8111-111111111111')).status,200);payments.get('tr_ABCDEF1').status='paid';assert.equal((await hook('tr_ABCDEF1')).status,200);
 assert.equal((await create('22222222-2222-4222-8222-222222222222')).status,200);refunded=true;assert.equal((await hook('tr_ABCDEF1')).status,200);
 const row=await e.DB.prepare('SELECT payment_id,state FROM rig_cancel_requests WHERE user_id=?').bind('alice').first();assert.equal(row.payment_id,'tr_ABCDEF2');assert.equal(row.state,'queued');
 } finally {globalThis.fetch=old;}
});

test('payment order lookup is routed, method-checked, authenticated and owner-bound',async()=>{
 const {createRouter}=await import('./router.mjs');const e=env(),requestId='order-request-123456';await e.DB.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,state) VALUES(?,?,?,?,?,?,?)').bind('order-id-12345678','alice',requestId,'small',500,500,'unknown').run();
 let identity='alice';const route=createRouter({identity:async()=>identity,limit:async()=>true});const mk=(path,method='GET')=>new Request(origin+path,{method,headers:method==='POST'?{origin,'content-type':'application/json'}:{},...(method==='POST'?{body:'{}'}:{})});
 let r=await route(mk(`/api/payments/orders/${requestId}`),e);assert.equal(r.status,200);assert.equal((await r.json()).state,'unknown');
 r=await route(mk(`/api/payments/orders/${requestId}`,'POST'),e);assert.equal(r.status,405);
 r=await route(mk(`/api/payments/orders/${requestId}/reconcile`),e);assert.equal(r.status,405);
 r=await route(mk(`/api/payments/orders/${requestId}/reconcile`,'POST'),e);assert.equal(r.status,200);assert.equal((await r.json()).state,'unknown');
 identity='bob';r=await route(mk(`/api/payments/orders/${requestId}`),e);assert.equal(r.status,404);
 identity=null;r=await route(mk(`/api/payments/orders/${requestId}`),e);assert.equal(r.status,401);
});

test('owner-only media opt-in allows bounded test upload but never enables paid generation',async()=>{
 const e=env();let mediaCalls=0;
 e.RIG_MEDIA_SECRET='x'.repeat(40);e.FAL_KEY='fake';e.RIG_OWNER_MEDIA_DAILY_LIMIT='2';e.RIG_MEDIA={fetch:async()=>{mediaCalls++;return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'alice',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480})}};
 const image=async(user='alice')=>signed({path:'/api/assets',method:'POST',body:'fixture',user,headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'}});
 assert.equal((await stage.fetch(await image(),e)).status,503);assert.equal(mediaCalls,0);
 e.RIG_OWNER_ASSETS_ENABLED='yes';assert.equal((await stage.fetch(await image('bob'),e)).status,401);assert.equal(mediaCalls,0);
 assert.equal((await stage.fetch(await image(),e)).status,201);assert.equal((await stage.fetch(await image(),e)).status,201);assert.equal((await stage.fetch(await image(),e)).status,429);assert.equal(mediaCalls,2);
 assert.equal(stagingTesting.falConfigured(e),false);
 const gen=await signed({path:'/api/generations',method:'POST',body:'{}',headers:{origin,'content-type':'application/json'}});assert.equal((await stage.fetch(gen,e)).status,503);
});
test('optional reference images have a separate owner-only retry quota and do not exhaust image/video quota',async()=>{
 const e=env();e.RIG_MEDIA_SECRET='x'.repeat(40);e.FAL_KEY='fake';e.RIG_OWNER_MEDIA_DAILY_LIMIT='4';e.RIG_OWNER_REFERENCE_DAILY_LIMIT='8';e.RIG_OWNER_ASSETS_ENABLED='yes';let mediaCalls=0;
 e.RIG_MEDIA={fetch:async()=>{mediaCalls++;return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'alice',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480})}};
 const image=async(role,user='alice')=>signed({path:'/api/assets',method:'POST',body:'fixture',user,headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':role}});
 assert.equal((await stage.fetch(await image('face','bob'),e)).status,401);
 for(let i=0;i<4;i++)assert.equal((await stage.fetch(await image('image'),e)).status,201);
 assert.equal((await stage.fetch(await image('image'),e)).status,429);
 for(let i=0;i<2;i++)assert.equal((await stage.fetch(await image(i===0?'face':'angle'),e)).status,201);
 // Each preparation counts once. All twelve allowed image/reference uploads
 // fit the unchanged write burst; the separate daily reference quota still wins.
 for(let i=2;i<8;i++)assert.equal((await stage.fetch(await image(i%4===0?'face':'angle'),e)).status,201);
 assert.equal((await stage.fetch(await image('angle'),e)).status,429);
 assert.equal(mediaCalls,12);
});
test('reference quota is explicit and bounded while ordinary uploads still work',async()=>{
 const e=env();e.RIG_MEDIA_SECRET='x'.repeat(40);e.FAL_KEY='fake';e.RIG_OWNER_MEDIA_DAILY_LIMIT='4';e.RIG_OWNER_ASSETS_ENABLED='yes';let calls=0;
 e.RIG_MEDIA={fetch:async()=>{calls++;return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'alice',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480})}};
 const post=async(role)=>signed({path:'/api/assets',method:'POST',body:'fixture',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':role}});
 for(const value of [undefined,'0','9','99','-1','x']){e.RIG_OWNER_REFERENCE_DAILY_LIMIT=value;assert.equal((await stage.fetch(await post('face'),e)).status,429)}
 assert.equal((await stage.fetch(await post('image'),e)).status,201);assert.equal(calls,1);
});
test('independent ephemeral media-test allowance stays at two even when the generation retry quota is four',async()=>{
 const e=env();e.RIG_MEDIA_SECRET='x'.repeat(40);e.RIG_OWNER_MEDIA_DAILY_LIMIT='4';e.RIG_OWNER_MEDIA_TEST_ENABLED='yes';let calls=0;
 e.RIG_MEDIA={fetch:async()=>{calls++;return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'alice',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480,cleanup:'ok'})}};
 const post=async()=>signed({path:'/api/media/test',method:'POST',body:'fixture',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'}});
 assert.equal((await stage.fetch(await post(),e)).status,200);assert.equal((await stage.fetch(await post(),e)).status,200);assert.equal((await stage.fetch(await post(),e)).status,429);assert.equal(calls,2);
});
test('ambiguous media service result retains backend lease',async()=>{
 const e=env();let released=0;const gateway=createStageGateway({verify:async(req)=>({request:req,user:'alice'}),route:async()=>new Response('error',{status:503,headers:{'x-rig-media-uncertain':'1'}}),acquire:async()=> 'lease',release:async()=>{released++}});
 const r=await gateway(new Request(origin+'/api/assets',{method:'POST',body:'x'}),e);assert.equal(r.status,503);assert.equal(released,0);
});
test('owner trial is distinct from generation, passes cleanup flag, and needs no fal key',async()=>{
 const e=env();e.RIG_MEDIA_SECRET='x'.repeat(40);e.RIG_OWNER_MEDIA_DAILY_LIMIT='2';e.RIG_OWNER_MEDIA_TEST_ENABLED='yes';let calls=0;
 e.RIG_MEDIA={fetch:async req=>{calls++;assert.equal(req.headers.get('x-rig-ephemeral-test'),'1');return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'alice',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480,cleanup:'ok'})}};
 const request=async(user='alice')=>signed({path:'/api/media/test',method:'POST',body:'fixture',user,headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'}});
 assert.equal((await stage.fetch(await request('bob'),e)).status,401);const r=await stage.fetch(await request(),e);assert.equal(r.status,200);const data=await r.json();assert.deepEqual(data,{status:'verified',cleanup:'ok',kind:'image',width:640,height:480});assert.equal(calls,1);assert.equal(stagingTesting.falConfigured(e),false);
});
test('backend separately enforces trial and retained asset gates after signed ingress',async()=>{
 const e=env();e.RIG_MEDIA_SECRET='x'.repeat(40);e.FAL_KEY='fake';e.RIG_OWNER_MEDIA_DAILY_LIMIT='2';let calls=0;
 e.RIG_MEDIA={fetch:async req=>{calls++;return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'alice',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480,...(req.headers.get('x-rig-ephemeral-test')==='1'?{cleanup:'ok'}:{})})}};
 const post=async path=>signed({path,method:'POST',body:'fixture',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'}});
 e.RIG_OWNER_MEDIA_TEST_ENABLED='yes';assert.equal((await stage.fetch(await post('/api/assets'),e)).status,503);assert.equal(calls,0);
 assert.equal((await stage.fetch(await post('/api/media/test'),e)).status,200);assert.equal(calls,1);
 e.RIG_OWNER_MEDIA_TEST_ENABLED='no';e.RIG_OWNER_ASSETS_ENABLED='yes';assert.equal((await stage.fetch(await post('/api/media/test'),e)).status,503);assert.equal(calls,1);
 assert.equal((await stage.fetch(await post('/api/assets'),e)).status,201);assert.equal(calls,2);
});
test('two completed trial preparations do not exhaust the two generation-asset preparations',async()=>{
 const e=env();e.RIG_MEDIA_SECRET='x'.repeat(40);e.FAL_KEY='fake';e.RIG_OWNER_MEDIA_DAILY_LIMIT='2';e.RIG_OWNER_MEDIA_TEST_ENABLED='yes';e.RIG_OWNER_ASSETS_ENABLED='yes';let trial=0,assets=0;
 e.RIG_MEDIA={fetch:async req=>{const ephemeral=req.headers.get('x-rig-ephemeral-test')==='1';if(ephemeral)trial++;else assets++;return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'alice',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480,...(ephemeral?{cleanup:'ok'}:{})})}};
 const post=async path=>signed({path,method:'POST',body:'fixture',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'}});
 assert.equal((await stage.fetch(await post('/api/media/test'),e)).status,200);assert.equal((await stage.fetch(await post('/api/media/test'),e)).status,200);assert.equal((await stage.fetch(await post('/api/media/test'),e)).status,429);
 assert.equal((await stage.fetch(await post('/api/assets'),e)).status,201);assert.equal((await stage.fetch(await post('/api/assets'),e)).status,201);assert.equal((await stage.fetch(await post('/api/assets'),e)).status,429);
 assert.equal(trial,2);assert.equal(assets,2);
});
test('owner generation asset allowance permits two further uploads beyond twenty, with other quotas isolated',async()=>{
 const e=env();e.RIG_MEDIA_SECRET='x'.repeat(40);e.RIG_OWNER_MEDIA_DAILY_LIMIT='20';e.RIG_OWNER_REFERENCE_DAILY_LIMIT='8';e.RIG_OWNER_ASSETS_ENABLED='yes';e.RIG_MEDIA_TEST_ENABLED='yes';e.RIG_MEDIA={fetch:async()=>new Response()};
 assert.equal(stagingTesting.mediaConfigured(e,'alice','/api/assets'),true);
 for(const invalid of ['0','23','99','010','-1','x'])assert.equal(stagingTesting.mediaConfigured({...e,RIG_OWNER_MEDIA_DAILY_LIMIT:invalid},'alice','/api/assets'),false);
 assert.equal(stagingTesting.mediaConfigured({...e,RIG_OWNER_MEDIA_DAILY_LIMIT:'22'},'bob','/api/assets'),false);
 for(let i=0;i<20;i++)assert.equal(await stagingTesting.takeOwnerMediaAllowance(e,'alice','/api/assets',i%2?'video':'image'),true);
 e.RIG_OWNER_MEDIA_DAILY_LIMIT='22';
 assert.equal(stagingTesting.mediaConfigured(e,'alice','/api/assets'),true);
 assert.equal(await stagingTesting.takeOwnerMediaAllowance(e,'alice','/api/assets','image'),true);
 assert.equal(await stagingTesting.takeOwnerMediaAllowance(e,'alice','/api/assets','video'),true);
 assert.equal(await stagingTesting.takeOwnerMediaAllowance(e,'alice','/api/assets','image'),false);
 for(let i=0;i<8;i++)assert.equal(await stagingTesting.takeOwnerMediaAllowance(e,'alice','/api/assets','angle'),true);
 assert.equal(await stagingTesting.takeOwnerMediaAllowance(e,'alice','/api/assets','face'),false);
 for(let i=0;i<2;i++)assert.equal(await stagingTesting.takeOwnerMediaAllowance(e,'alice','/api/media/test','image'),true);
 assert.equal(await stagingTesting.takeOwnerMediaAllowance(e,'alice','/api/media/test','image'),false);
});
