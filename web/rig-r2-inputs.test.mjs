import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {r2InputsConfig,mintR2Input,isR2InputUrl,verifyR2Input} from './rig-r2-inputs.mjs';

// Synthetic credentials only; no remote storage is contacted by these tests.
const config={accountId:'a'.repeat(32),bucket:'rig-test-inputs',accessKeyId:'b'.repeat(32),secretAccessKey:'c'.repeat(64)};
const env={RIG_R2_INPUTS_ENABLED:'yes',RIG_R2_INPUTS_ACCOUNT_ID:config.accountId,RIG_R2_INPUTS_BUCKET:config.bucket,RIG_R2_INPUTS_ACCESS_KEY_ID:config.accessKeyId,RIG_R2_INPUTS_SECRET_ACCESS_KEY:config.secretAccessKey};
const key='rig-inputs/provider/'+'d'.repeat(64)+'.mp4';
const sample=Uint8Array.from({length:100},(_,i)=>i);
const response=(bytes=sample,{status=200,headers={}}={})=>new Response(bytes,{status,headers:{'content-type':'video/mp4','content-length':String(bytes.length),...headers}});
function mock(){const calls=[];return {calls,async fetch(url,options){calls.push({url,options});return options.headers?response(sample.slice(0,64),{status:206,headers:{'content-range':'bytes 0-63/100'}}):response()}}}

test('R2 input signing is opt-in and rejects invalid or incomplete configuration',()=>{
 assert.deepEqual(r2InputsConfig(env),config);
 for(const patch of [{RIG_R2_INPUTS_ENABLED:'no'},{RIG_R2_INPUTS_ACCOUNT_ID:'x'},{RIG_R2_INPUTS_BUCKET:'../other'},{RIG_R2_INPUTS_ACCESS_KEY_ID:''},{RIG_R2_INPUTS_SECRET_ACCESS_KEY:undefined},{RIG_R2_INPUTS_SECRET_ACCESS_KEY:'c'.repeat(64)+'\n'}])assert.equal(r2InputsConfig({...env,...patch}),null);
});
test('SigV4 matches an independent Node crypto calculation and fixes host, method and lifetime',async()=>{
 const now=Date.UTC(2026,10,7,12,34,56),url=await mintR2Input({config,key,now}),u=new URL(url),params=u.searchParams;
 assert.equal(u.hostname,config.accountId+'.eu.r2.cloudflarestorage.com');assert.equal(u.pathname,'/'+config.bucket+'/'+key);
 assert.equal(params.get('X-Amz-Date'),'20261107T123456Z');assert.equal(params.get('X-Amz-Expires'),'3600');assert.equal(params.get('X-Amz-SignedHeaders'),'host');assert.equal(params.get('X-Amz-Content-Sha256'),'UNSIGNED-PAYLOAD');
 const esc=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 const query=[...params].filter(([k])=>k!=='X-Amz-Signature').sort(([a],[b])=>a.localeCompare(b,'en',{sensitivity:'variant'})).map(([k,v])=>esc(k)+'='+esc(v)).join('&');
 const canonical=['GET',u.pathname,query,'host:'+u.hostname+'\n','host','UNSIGNED-PAYLOAD'].join('\n');
 const sha=s=>createHash('sha256').update(s).digest('hex'),hmac=(k,s)=>createHmac('sha256',k).update(s).digest();
 const signing=hmac(hmac(hmac(hmac('AWS4'+config.secretAccessKey,'20261107'),'auto'),'s3'),'aws4_request');
 const expected=createHmac('sha256',signing).update(['AWS4-HMAC-SHA256','20261107T123456Z','20261107/auto/s3/aws4_request',sha(canonical)].join('\n')).digest('hex');
 assert.equal(params.get('X-Amz-Signature'),expected);assert.equal(isR2InputUrl(url,{config,key,kind:'video',now}),true);
 assert.equal(isR2InputUrl(url,{config:{accountId:config.accountId,bucket:config.bucket},kind:'video',now}),true);
 const headCanonical=['HEAD',u.pathname,query,'host:'+u.hostname+'\n','host','UNSIGNED-PAYLOAD'].join('\n');
 const head=createHmac('sha256',signing).update(['AWS4-HMAC-SHA256','20261107T123456Z','20261107/auto/s3/aws4_request',sha(headCanonical)].join('\n')).digest('hex');
 assert.notEqual(expected,head,'GET URLs must not be used for a HEAD probe');
});
test('only opaque delivery object keys can be signed, never source/user keys or arbitrary URLs',async()=>{
 for(const objectKey of ['rig-inputs/alice/private.mp4','rig-inputs/provider/'+ 'd'.repeat(64),key+'?x=1',key+'/../other.mp4','rig-inputs/provider/'+'D'.repeat(64)+'.mp4',key.replace('.mp4','.txt'),'https://attacker.invalid/'+key])await assert.rejects(mintR2Input({config,key:objectKey}),/R2 signing unavailable/);
 for(const now of [-1,NaN,1.5,Number.MAX_SAFE_INTEGER])await assert.rejects(mintR2Input({config,key,now}),/R2 signing unavailable/);
});
test('URL validation binds EU tenant, bucket, credential, key, media kind, expiry and exact query shape',async()=>{
 const now=Date.UTC(2026,10,7,12,34,56),url=await mintR2Input({config,key,now});
 const bad=[url.replace('.eu.r2.','.r2.'),url.replace(config.accountId,'e'.repeat(32)),url.replace(config.bucket,'other-bucket'),url.replace('.mp4?','.jpg?'),url+'&other=1',url+'&X-Amz-Expires=3600',url+'#fragment',url.replace('X-Amz-Expires=3600','X-Amz-Expires=7200'),url.replace('X-Amz-SignedHeaders=host','X-Amz-SignedHeaders=host%3Brange'),url.replace('X-Amz-Date=20261107T123456Z','X-Amz-Date=20261307T123456Z'),url.replace(config.accessKeyId,'e'.repeat(32))];
 for(const value of bad)assert.equal(isR2InputUrl(value,{config,key,kind:'video',now}),false);
 assert.equal(isR2InputUrl(url,{config,key,kind:'image',now}),false);assert.equal(isR2InputUrl(url,{config,key:key.replace(/d/g,'e'),kind:'video',now}),false);
 assert.equal(isR2InputUrl(url,{config,key,kind:'video',now:now+3600000}),false);assert.equal(isR2InputUrl(url,{config,key,kind:'video',now:now-60000}),false);
});
test('exact full GET and range readback succeed without any authentication headers',async()=>{
 const url=await mintR2Input({config,key}),m=mock();
 assert.deepEqual(await verifyR2Input(url,{config,key,kind:'video',bytes:sample,fetchImpl:m.fetch}),{verified:true,readbackVerified:true,rangeVerified:true});
 assert.equal(m.calls.length,2);for(const c of m.calls){assert.equal(c.options.method,'GET');assert.equal(c.options.redirect,'manual');assert.equal(new Headers(c.options.headers).has('authorization'),false);assert.equal(new Headers(c.options.headers).has('cookie'),false)}
 assert.equal(m.calls[0].options.headers,undefined);assert.equal(new Headers(m.calls[1].options.headers).get('range'),'bytes=0-63');
});
test('redirects, leaked source metadata, wrong MIME/length, truncated or changed bytes fail closed',async()=>{
 const url=await mintR2Input({config,key});
 for(const r of [new Response(null,{status:302,headers:{location:'https://attacker.invalid/'}}),response(sample,{headers:{'x-amz-meta-manifest':'must-not-leave-private-storage'}}),response(sample,{headers:{'content-type':'application/octet-stream'}}),response(sample,{headers:{'content-length':'101'}}),response(sample.slice(0,90),{headers:{'content-length':'100'}}),response(new Uint8Array(100))]){
  let calls=0;await assert.rejects(verifyR2Input(url,{config,key,kind:'video',bytes:sample,fetchImpl:async()=>{calls++;return r}}),error=>error.message==='Private R2 input could not be verified'&&!error.message.includes(url));assert.equal(calls,1);
 }
});
test('a downloader that ignores range or changes range bytes is rejected',async()=>{
 const url=await mintR2Input({config,key});
 for(const range of [response(),response(sample.slice(0,64),{status:206,headers:{'content-range':'bytes 1-64/100'}}),response(new Uint8Array(64),{status:206,headers:{'content-range':'bytes 0-63/100'}})]){
  let calls=0;await assert.rejects(verifyR2Input(url,{config,key,kind:'video',bytes:sample,fetchImpl:async()=>++calls===1?response():range}),error=>error.rigInputStage==='r2_range');assert.equal(calls,2);
 }
});
test('untrusted URLs cannot cause a request and body transport details never escape in errors',async()=>{
 let calls=0;await assert.rejects(verifyR2Input('https://attacker.invalid/',{config,key,kind:'video',bytes:sample,fetchImpl:async()=>{calls++}}));assert.equal(calls,0);
 const url=await mintR2Input({config,key});
 const stream=new ReadableStream({pull(controller){controller.error(Error('private-transport-detail'))}});
 await assert.rejects(verifyR2Input(url,{config,key,kind:'video',bytes:sample,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'video/mp4','content-length':'100'}})}),error=>error.message==='Private R2 input could not be verified'&&error.rigInputStage==='r2_integrity');
});
