import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadVerifiedAsset,privateResultFetch} from './upload.mjs';
import {stagingTesting} from './staging.mjs';
const file='https://v3b.fal.media/files/b/store/image.jpg';
const signed=file+'?identity=opaque';
const asset={verified:true,mime:'image/jpeg',size:3,body:new Blob(['abc'])};
test('the staging composition never enables chargeable fal calls through flags alone',()=>{
 assert.equal(stagingTesting.falConfigured({RIG_FAL_STAGING_ENABLED:'yes',RIG_FAL_STAGING_COST_APPROVED:'yes',FAL_KEY:'secret'}),false);
});
function mock({acl='forbid',anonymous=403,output=signed,signedStatus=200,signedBody='abc',signedType='image/jpeg'}={}) {
 const seen=[];
 const fetcher=async(url,o={})=>{
   seen.push({url,options:o});
   if(url.startsWith('https://rest.fal.ai/storage/upload/initiate'))return Response.json({upload_url:'https://upload.fal.media/upload?signature=abc',file_url:file});
   if(url.startsWith('https://upload.fal.media/'))return new Response(null,{status:200});
   if(url.startsWith('https://rest.fal.ai/storage/files/acl'))return Response.json({default:acl,rules:[]});
   if(url.startsWith('https://rest.fal.ai/storage/auth/token'))return Response.json({token:'cdn-token'});
   if(url===file+'/sign')return new Response(output);
   if(url===signed)return new Response(signedBody,{status:signedStatus,headers:{'content-type':signedType}});
   if(url===file&&o.headers?.Authorization)return new Response('result');
   if(url===file)return new Response(null,{status:anonymous});
   throw Error('Unexpected call');
 };
 return {seen,fetcher};
}
test('private upload uses independent ACL, checks it, verifies denial, then mints matching signed read URL',async()=>{
 const m=mock();assert.equal(await uploadVerifiedAsset({asset,key:'secret',fetchImpl:m.fetcher}),signed);
 const init=m.seen[0].options;assert.deepEqual(JSON.parse(init.headers['X-Fal-Object-Lifecycle-Preference']),{expiration_duration_seconds:86400,initial_acl:{default:'forbid',rules:[]}});
 assert.equal(m.seen[1].options.headers.Authorization,undefined);assert.equal(m.seen[4].options.headers.Authorization,'Key secret');
 assert.deepEqual(JSON.parse(m.seen[5].options.body),{duration:21600,scope:['read']});assert.equal(m.seen[5].options.headers.Authorization,'Bearer cdn-token');
 assert.equal(m.seen[6].url,signed);assert.equal(new Headers(m.seen[6].options.headers).has('authorization'),false);
 assert.ok(m.seen.every(x=>x.options.redirect==='manual'));
});
test('signed input must be anonymously reachable and byte-identical before any model can receive it',async()=>{
 for(const scenario of [{signedStatus:403},{signedStatus:302},{signedBody:'abd'},{signedBody:'abcd'},{signedType:'text/html'}]){
  const m=mock(scenario);await assert.rejects(uploadVerifiedAsset({asset,key:'secret',fetchImpl:m.fetcher}),error=>/^signed_/.test(error.rigInputStage));
 }
 const spaced=mock({output:signed+'\n'});assert.equal(await uploadVerifiedAsset({asset,key:'secret',fetchImpl:spaced.fetcher}),signed);
});
test('fails closed if ACL, anonymous access, signed destination or verified media is wrong',async()=>{
 for(const scenario of [{acl:'allow'},{anonymous:200},{output:'https://attacker.invalid/a?identity=x'},{output:'https://v3b.fal.media/files/b/store/other.jpg?identity=x'}]){
  const m=mock(scenario);await assert.rejects(uploadVerifiedAsset({asset,key:'secret',fetchImpl:m.fetcher}));
 }
 const m=mock();await assert.rejects(uploadVerifiedAsset({asset:{...asset,verified:false},key:'secret',fetchImpl:m.fetcher}));assert.equal(m.seen.length,0);
});
test('private result download refuses other origins and sends CDN token only to the strict fal CDN URL',async()=>{
 const m=mock();const fetcher=privateResultFetch('secret',m.fetcher);
 await assert.rejects(fetcher('https://evil.example/result'));
 const r=await fetcher(file,{signal:AbortSignal.timeout(1000)});assert.equal(await r.text(),'result');assert.equal(m.seen[3].options.headers.Authorization,'Bearer cdn-token');
 const open=mock({anonymous:200});await assert.rejects(privateResultFetch('secret',open.fetcher)(file));assert.equal(open.seen.length,2);
});

test('every upload step rejects redirects without forwarding credentials or treating a redirect as private',async()=>{
 for(const status of [301,302,303,307,308])for(let step=0;step<6;step++){
  const m=mock();let call=0;
  const fetcher=async(url,options)=>{
   assert.equal(options.redirect,'manual');
   if(call++===step)return new Response(null,{status,headers:{Location:'https://attacker.invalid/collect'}});
   return m.fetcher(url,options);
  };
  await assert.rejects(uploadVerifiedAsset({asset,key:'secret',fetchImpl:fetcher}));
  assert.equal(call,step+1,`redirect ${status} at step ${step} must stop all later requests`);
 }
});
test('private result download rejects redirects at every privacy and fetch step',async()=>{
 for(const status of [301,302,303,307,308])for(let step=0;step<4;step++){
  const m=mock();let call=0;
  const fetcher=async(url,options)=>{
   assert.equal(options.redirect,'manual');
   if(call++===step)return new Response(null,{status,headers:{Location:'https://attacker.invalid/collect'}});
   return m.fetcher(url,options);
  };
  await assert.rejects(privateResultFetch('secret',fetcher)(file));
  assert.equal(call,step+1);
 }
});

test('poll deadline stops every private result step and prevents later requests',async()=>{
 for(let stopAt=0;stopAt<4;stopAt++){
  const m=mock();const controller=new AbortController();let calls=0;
  const fetcher=async(url,options)=>{
   assert.ok(options.signal);assert.equal(options.signal.aborted,false);
   const index=calls++;
   if(index===stopAt){
    const waiting=new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
    controller.abort();return waiting;
   }
   return m.fetcher(url,options);
  };
  await assert.rejects(privateResultFetch('secret',fetcher)(file,{signal:controller.signal}));
  assert.equal(calls,stopAt+1);
 }
 const m=mock();const expired=new AbortController();expired.abort();
 await assert.rejects(privateResultFetch('secret',m.fetcher)(file,{signal:expired.signal}));assert.equal(m.seen.length,0);
});
test('poll expiry after a response still prevents token minting or result download',async()=>{
 for(let stopAt=0;stopAt<4;stopAt++){
  const m=mock();const controller=new AbortController();let calls=0;
  const fetcher=async(url,options)=>{const response=await m.fetcher(url,options);if(calls++===stopAt)controller.abort();return response};
  await assert.rejects(privateResultFetch('secret',fetcher)(file,{signal:controller.signal}));
  assert.equal(calls,stopAt+1);
 }
});
