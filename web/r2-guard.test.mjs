import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import stage, {stagingTesting} from './staging.mjs';
import {gatewayTesting} from './gateway.mjs';

function fixture() {
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('./cloudflare-migrations/0001_test_baseline.sql',import.meta.url),'utf8'));
  const DB={prepare(query){let args=[];return {bind(...values){args=values;return this},async first(){return sql.prepare(query).get(...args)??null},async run(){return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}}},async all(){return {results:sql.prepare(query).all(...args)}}}},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results}catch(error){sql.exec('ROLLBACK');throw error}}};
  let bucketCalls=0,mediaCalls=0;
  const bucket={async put(){bucketCalls++;throw Error('bucket unexpectedly called')},async get(){bucketCalls++;throw Error('bucket unexpectedly called')},async head(){bucketCalls++;throw Error('bucket unexpectedly called')}};
  const env={DB,BUCKET:bucket,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',MOLLIE_API_KEY:'test_abc',RIG_GATEWAY_KEY:'ab'.repeat(32),RIG_GATEWAY_CONFIGURED:'yes',RIG_WEBHOOK_PRIVATE_SERVICE_ONLY:'yes',RIG_PUBLIC_ORIGIN:'https://rig.example',RIG_STAGING_OWNER:'alice',RIG_WEBHOOK_URL:'https://hooks.example/api/payments/webhook',RIG_PACKAGES:'[{"id":"small","amountCents":500,"credits":500}]',RIG_FAL_STAGING_ENABLED:'yes',RIG_FAL_STAGING_COST_APPROVED:'yes',RIG_FAL_PRICE_PREFLIGHT_ENABLED:'no',FAL_KEY:'fixture',RIG_MEDIA:{async fetch(){mediaCalls++;throw Error('media unexpectedly called')}},RIG_MEDIA_SECRET:'x'.repeat(32),RIG_PRICE_STANDARD:'100',RIG_PRICE_PRO:'150',RIG_PRICE_VERSION:'test'};
  return {env,counts:()=>({bucketCalls,mediaCalls}),close:()=>sql.close()};
}
async function signed(env,path,nonce) {
  const body='{}',headers=new Headers({origin:env.RIG_PUBLIC_ORIGIN,'content-type':'application/json'});
  const hex=data=>Array.from(new Uint8Array(data),n=>n.toString(16).padStart(2,'0')).join('');
  const digest=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)));
  const time=String(Date.now()),user=env.RIG_STAGING_OWNER;
  const secret=Uint8Array.from(env.RIG_GATEWAY_KEY.match(/../g),v=>parseInt(v,16));
  const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const canonical=gatewayTesting.canonical('POST',path,user,time,nonce,digest,headers);
  headers.set('x-rig-gateway-user',user);headers.set('x-rig-gateway-time',time);headers.set('x-rig-gateway-nonce',nonce);headers.set('x-rig-gateway-body-sha256',digest);
  headers.set('x-rig-gateway-signature',hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(canonical))));
  return new Request(env.RIG_PUBLIC_ORIGIN+path,{method:'POST',headers,body,duplex:'half'});
}

test('an R2 binding and all fal flags cannot activate uploads, quotes or generation',async()=>{
  const f=fixture(),oldFetch=globalThis.fetch;let providerCalls=0;
  globalThis.fetch=async()=>{providerCalls++;throw Error('provider unexpectedly called')};
  try{
    assert.equal(stagingTesting.falConfigured(f.env),false);
    for(const [i,path] of ['/api/assets','/api/generation-quotes','/api/generations'].entries()){
      const response=await stage.fetch(await signed(f.env,path,String(i+1).padStart(32,'0')),f.env);
      assert.equal(response.status,503,path);
    }
    assert.deepEqual(f.counts(),{bucketCalls:0,mediaCalls:0});
    assert.equal(providerCalls,0);
  }finally{globalThis.fetch=oldFetch;f.close()}
});
