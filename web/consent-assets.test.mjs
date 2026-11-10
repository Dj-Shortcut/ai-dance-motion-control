import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssets} from './assets.mjs';
import {RECAST_MODEL} from './recast-contract.mjs';
const id='12345678-1234-1234-1234-123456789abc', bytes=new TextEncoder().encode('fake media content for no provider test');
const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
test('priced asset reads local metadata and bytes without contacting provider',async()=>{
 let provider=0;
 const a=createAssets({mode:'test',origin:'https://rig.test',mediaSecret:'s'.repeat(32),falKey:'key',limit:async()=>true,authenticate:async()=>({id:'u1'}),media:{fetch:async()=>new Response(bytes,{headers:{'content-type':'image/jpeg','content-length':String(bytes.length),'x-rig-asset-kind':'image','x-rig-sha256':hash,'x-rig-width':'500','x-rig-height':'500'}})},providerFetch:async()=>{provider++;throw Error('unexpected provider')}});
 const m=await a.getOwned('u1',id);assert.equal(m.sha256,hash);assert.equal(m.id,id);assert.equal(m.url,undefined);assert.equal(provider,0);
 await assert.rejects(a.uploadOwned('u1',id,'b'.repeat(64)),/asset changed/);assert.equal(provider,0);
});
test('oversized supposedly prepared Recast media is refused before byte export or provider work',async()=>{
 let provider=0;
 const data=new Uint8Array(16*1024*1024+1),sha=Buffer.from(await crypto.subtle.digest('SHA-256',data)).toString('hex');
 const assets=createAssets({mode:'test',origin:'https://rig.test',mediaSecret:'s'.repeat(32),falKey:'key',limit:async()=>true,authenticate:async()=>({id:'u1'}),media:{fetch:async()=>new Response(data,{headers:{'content-type':'image/jpeg','content-length':String(data.length),'x-rig-asset-kind':'image','x-rig-sha256':sha,'x-rig-width':'1280','x-rig-height':'720'}})},providerFetch:async()=>{provider++;throw Error('unexpected provider');}});
 await assert.rejects(assets.uploadOwned('u1',id,sha,{jobId:'33333333-3333-4333-8333-333333333333',model:RECAST_MODEL,transferPolicy:'fal-temporary-links-v1'}),/bad asset/);assert.equal(provider,0);
});
