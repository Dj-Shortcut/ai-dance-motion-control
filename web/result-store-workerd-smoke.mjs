// Local in-memory R2 and fake provider only: never contacts Cloudflare or fal.
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');
const {build}=require('esbuild'),{Miniflare}=require('miniflare');
const tmp=await mkdtemp(join(process.cwd(),'.rig-r2-smoke-'));let mf;
try{
 const bundle=join(tmp,'worker.mjs');await build({entryPoints:['result-store-workerd-fixture.mjs'],outfile:bundle,bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({modules:true,scriptPath:bundle,compatibilityDate:'2026-01-01',r2Buckets:['BUCKET']});
 for(const path of ['/','/','/unknown','/unknown']){const r=await mf.dispatchFetch('https://local.invalid'+path);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[0,0,0,20,102,116,121,112,105,115,111,109,1,2,3,4,5,6,7,8]);}
 console.log('workerd: private result streaming and idempotent R2 read succeeded locally with fake provider');
}finally{if(mf)await mf.dispose();await rm(tmp,{recursive:true,force:true})}
