// Synthetic responses and a read-only policy adapter. No real provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFundingCoverage} from './funding-coverage.mjs';
const USERNAME='private-fixture-account',KEY='private-fixture-key';
const finance={id:1,version:'fixture-v1',eur_per_usd_micros:1000000,provider_vat_bps:2100,payment_fee_bps:500,failure_buffer_bps:1000,preparation_cents:10,min_margin_bps:3500,daily_provider_limit_usd_micros:10000000,min_price_cents:75,min_pro_price_cents:100};
const payload=()=>({username:USERNAME,credits:{current_balance:20,currency:'USD'}});
function fixture({response=()=>Response.json(payload()),exposureFailure=false}={}){
 const db={batch(){throw Error('Diagnostics must never write')},prepare(sql){return {async first(){
  if(sql.includes('rig_funding_policy'))return {id:1,enabled:1,version:'fixture-funding',expected_username:USERNAME,buffer_usd_micros:6000000,max_snapshot_age_ms:60000};
  if(sql.includes('rig_payment_environment'))return {mode:'live'};
  if(sql.includes('rig_finance_policy'))return finance;
  if(sql.includes('rig_funding_exposure')){if(exposureFailure)throw Error(KEY+USERNAME);return {positive_wallet_cents:0,held_retail_cents:0,payable_order_cents:0,provider_reserved_usd_micros:0,wallet_type:'integer',held_type:'integer',orders_type:'integer',provider_type:'integer'};}
  throw Error('Unexpected query');
 }}}};
 const env={DB:db,FAL_KEY:KEY,RIG_FUNDING_COVERAGE_ENABLED:'yes'};
 const network=async(url,options)=>{assert.equal(url,'https://api.fal.ai/v1/account/billing?expand=credits');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(new Headers(options.headers).get('authorization'),'Key '+KEY);return response(options);};
 return {read:options=>readFundingCoverage(env,{network,...options})};
}
function safeDiagnostic(value,stage,status){
 assert.equal(value.status,'unavailable');assert.equal(value.reason,'funding_unavailable');assert.deepEqual(value.diagnostic,{stage,httpStatus:status});
 assert.doesNotMatch(JSON.stringify(value),new RegExp(USERNAME+'|'+KEY+'|provider-raw-text|https?://|Authorization'));
 assert.deepEqual(Object.keys(value.diagnostic).sort(),['httpStatus','stage']);
}
test('owner opt-in returns only whitelisted HTTP/schema failures; default and nonboolean options remain redacted',async()=>{
 const cases=[
  ['http_status',403,()=>Response.json({error:'provider-raw-text '+KEY},{status:403})],
  ['http_status',302,()=>new Response(null,{status:302,headers:{location:'https://attacker.invalid'}})],
  ['content_type',200,()=>new Response('provider-raw-text',{headers:{'content-type':'text/html'}})],
  ['content_encoding',200,()=>new Response('{}',{headers:{'content-type':'application/json','content-encoding':'unknown'}})],
  ['content_length_invalid',200,()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'wrong'}})],
  ['content_length_mismatch',200,()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'1'}})],
  ['body_size',200,()=>Response.json({padding:'x'.repeat(17000)})],
  ['json',200,()=>new Response('{"secret":"'+KEY,{headers:{'content-type':'application/json'}})],
  ['schema',200,()=>Response.json({unexpected:KEY})],
  ['account_mismatch',200,()=>Response.json({...payload(),username:'another-private-account'})],
  ['currency',200,()=>Response.json({username:USERNAME,credits:{current_balance:20,currency:'EUR'}})],
  ['balance',200,()=>Response.json({username:USERNAME,credits:{current_balance:'20',currency:'USD'}})],
  ['network',null,()=>{throw Error('provider-raw-text '+KEY)}]
 ];
 for(const [stage,status,response]of cases){const f=fixture({response});safeDiagnostic(await f.read({diagnostics:true}),stage,status);for(const diagnostics of [undefined,false,'true']){const value=await f.read({diagnostics});assert.equal(value.reason,'funding_unavailable');assert.equal(Object.hasOwn(value,'diagnostic'),false);assert.doesNotMatch(JSON.stringify(value),new RegExp(KEY+'|'+USERNAME+'|provider-raw-text'));}}
});
test('recognized compressed wire lengths are not compared with decoded bytes, while identity lengths stay exact',async()=>{
 const json=JSON.stringify(payload()),length=new TextEncoder().encode(json).length;
 for(const encoding of ['gzip','br',' GZIP ']){const f=fixture({response:()=>new Response(json,{headers:{'content-type':'application/json','content-encoding':encoding,'content-length':'7'}})});const value=await f.read({diagnostics:true});assert.equal(value.status,'ready');assert.equal(value.availableUsdMicros,20000000);assert.equal(Object.hasOwn(value,'diagnostic'),false);}
 for(const encoding of [undefined,'identity']){const f=fixture({response:()=>new Response(json,{headers:{'content-type':'application/json',...(encoding?{'content-encoding':encoding}:{}),'content-length':String(length)}})});assert.equal((await f.read({diagnostics:true})).status,'ready');}
 const mismatch=fixture({response:()=>new Response(json,{headers:{'content-type':'application/json','content-encoding':'identity','content-length':'7'}})});safeDiagnostic(await mismatch.read({diagnostics:true}),'content_length_mismatch',200);
});
test('compressed headers cannot bypass the decoded byte limit or account/currency/balance validation',async()=>{
 for(const [stage,data]of [['body_size',{...payload(),padding:'x'.repeat(17000)}],['account_mismatch',{...payload(),username:'wrong-account'}],['currency',{username:USERNAME,credits:{current_balance:20,currency:'EUR'}}],['balance',{username:USERNAME,credits:{current_balance:-1,currency:'USD'}}]]){
  const f=fixture({response:()=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json','content-encoding':'gzip','content-length':'20'}})});safeDiagnostic(await f.read({diagnostics:true}),stage,200);
 }
});
test('an exposure failure is classified without exposing database exception text',async()=>{
 const f=fixture({exposureFailure:true});safeDiagnostic(await f.read({diagnostics:true}),'exposure',null);assert.equal(Object.hasOwn(await f.read(),'diagnostic'),false);
});
test('concurrent owner and default reads share a failed provider request without sharing owner diagnostics',async()=>{
 let calls=0;const f=fixture({response:()=>{calls++;return Response.json({error:KEY},{status:403})}});
 const [owner,publicRead]=await Promise.all([f.read({diagnostics:true}),f.read()]);
 assert.equal(calls,1);safeDiagnostic(owner,'http_status',403);assert.equal(Object.hasOwn(publicRead,'diagnostic'),false);assert.equal(publicRead.reason,'funding_unavailable');
});
test('a real deadline is classified without waiting for or trusting a network exception',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let started=false;
 const f=fixture({response:()=>{started=true;return new Promise(()=>{})}}),pending=f.read({diagnostics:true});
 while(!started)await Promise.resolve();t.mock.timers.tick(10000);
 safeDiagnostic(await pending,'deadline',null);
});
