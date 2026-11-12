// Real localhost HTTP compression through workerd Fetch and the actual module.
// Synthetic policies/account/key only; no provider network or database writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {gzipSync,brotliCompressSync,deflateSync} from 'node:zlib';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('real compressed HTTP billing replies are decoded safely by workerd without equating wire Content-Length to decoded bytes',async()=>{
 const account='local-compression-fixture',plain=Buffer.from(JSON.stringify({username:account,credits:{current_balance:20,currency:'USD'},padding:'local-only-'.repeat(40)}));
 const replies=new Map([
  ['/identity',{bytes:plain}],['/gzip-length',{bytes:gzipSync(plain),encoding:'gzip'}],['/gzip-chunked',{bytes:gzipSync(plain),encoding:'gzip',chunked:true}],
  ['/br-length',{bytes:brotliCompressSync(plain),encoding:'br'}],['/deflate-length',{bytes:deflateSync(plain),encoding:'deflate'}],
  ['/gzip-oversize',{bytes:gzipSync(Buffer.from(JSON.stringify({username:account,credits:{current_balance:20,currency:'USD'},padding:'x'.repeat(17000)}))),encoding:'gzip'}],
  ['/gzip-wrong-account',{bytes:gzipSync(Buffer.from(JSON.stringify({username:'other-local-account',credits:{current_balance:20,currency:'USD'}}))),encoding:'gzip'}]
 ]),requests=[];
 const server=createServer((req,res)=>{requests.push({path:req.url,hasAuthorization:!!req.headers.authorization});const reply=replies.get(req.url);if(!reply){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','application/json');if(reply.encoding)res.setHeader('Content-Encoding',reply.encoding);if(reply.chunked)res.setHeader('Transfer-Encoding','chunked');else res.setHeader('Content-Length',reply.bytes.length);res.end(reply.bytes);});
 let mf;try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const finance={id:1,version:'fixture-v1',eur_per_usd_micros:1000000,provider_vat_bps:2100,payment_fee_bps:500,failure_buffer_bps:1000,preparation_cents:10,min_margin_bps:3500,daily_provider_limit_usd_micros:10000000,min_price_cents:75,min_pro_price_cents:100};
  const result=await build({stdin:{resolveDir:new URL('.',import.meta.url).pathname,contents:`
   import {readFundingCoverage} from './funding-coverage.mjs';
   export default {async fetch(request){
    const path=new URL(request.url).pathname;if(!${JSON.stringify([...replies.keys()])}.includes(path))return new Response(null,{status:404});
    const db={batch(){throw Error('No fixture writes')},prepare(sql){return {async first(){
     if(sql.includes('rig_funding_policy'))return {id:1,enabled:1,version:'fixture-funding',expected_username:${JSON.stringify(account)},buffer_usd_micros:6000000,max_snapshot_age_ms:60000};
     if(sql.includes('rig_payment_environment'))return {mode:'live'};
     if(sql.includes('rig_finance_policy'))return ${JSON.stringify(finance)};
     if(sql.includes('rig_funding_exposure'))return {positive_wallet_cents:0,held_retail_cents:0,payable_order_cents:0,provider_reserved_usd_micros:0,wallet_type:'integer',held_type:'integer',orders_type:'integer',provider_type:'integer'};
     throw Error('Unexpected query');
    }}}};
    const network=async(url,options)=>{if(url!=='https://api.fal.ai/v1/account/billing?expand=credits'||options.method!=='GET'||options.redirect!=='manual')throw Error('Unexpected fixture request');return fetch(${JSON.stringify(origin)}+path,{method:'GET',redirect:'manual',headers:{Accept:'application/json'}});};
    return Response.json(await readFundingCoverage({DB:db,FAL_KEY:'local-only-fixture',RIG_FUNDING_COVERAGE_ENABLED:'yes'},{network,diagnostics:true}));
   }};`},bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});
  mf=new Miniflare({cf:false,modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-01-01'});
  for(const path of ['/identity','/gzip-length','/gzip-chunked','/br-length']){
   const response=await mf.dispatchFetch('http://fixture.test'+path),value=await response.json();assert.equal(value.status,'ready',path+': '+JSON.stringify(value));assert.equal(value.availableUsdMicros,20000000);assert.equal(Object.hasOwn(value,'diagnostic'),false);
  }
  for(const [path,stage]of [['/deflate-length','content_encoding'],['/gzip-oversize','body_size'],['/gzip-wrong-account','account_mismatch']]){
   const value=await(await mf.dispatchFetch('http://fixture.test'+path)).json();assert.equal(value.status,'unavailable');assert.deepEqual(value.diagnostic,{stage,httpStatus:200});
  }
  assert.equal(requests.length,7);assert.ok(requests.every(request=>request.hasAuthorization===false));assert.ok(replies.get('/gzip-length').bytes.length<plain.length,'fixture has a real smaller compressed wire payload');
 }finally{if(mf)await mf.dispose();await new Promise(resolve=>server.close(resolve));}
});
