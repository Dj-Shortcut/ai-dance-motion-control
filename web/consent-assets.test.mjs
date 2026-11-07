import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssets} from './assets.mjs';
const id='12345678-1234-1234-1234-123456789abc', bytes=new TextEncoder().encode('fake media content for no provider test');
const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
test('priced asset reads local metadata and bytes without contacting provider',async()=>{
 let provider=0;
 const a=createAssets({mode:'test',origin:'https://rig.test',mediaSecret:'s'.repeat(32),falKey:'key',limit:async()=>true,authenticate:async()=>({id:'u1'}),media:{fetch:async()=>new Response(bytes,{headers:{'content-type':'image/jpeg','content-length':String(bytes.length),'x-rig-asset-kind':'image','x-rig-sha256':hash,'x-rig-width':'500','x-rig-height':'500'}})},providerFetch:async()=>{provider++;throw Error('unexpected provider')}});
 const m=await a.getOwned('u1',id);assert.equal(m.sha256,hash);assert.equal(m.id,id);assert.equal(m.url,undefined);assert.equal(provider,0);
 await assert.rejects(a.uploadOwned('u1',id,'b'.repeat(64)),/asset changed/);assert.equal(provider,0);
});
