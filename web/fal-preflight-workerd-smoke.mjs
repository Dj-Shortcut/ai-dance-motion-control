// Local Cloudflare workerd with fake auth and fake provider; no real secrets or network.
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');
const {build}=require('esbuild'), {Miniflare}=require('miniflare');
const tmp=await mkdtemp(join(process.cwd(),'.rig-price-smoke-'));let mf;
try{
 const bundle=join(tmp,'worker.mjs');
 await build({entryPoints:['fal-preflight-workerd-fixture.mjs'],outfile:bundle,bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({modules:true,scriptPath:bundle,compatibilityDate:'2026-01-01'});
 const r=await mf.dispatchFetch('https://owner.example/api/fal/preflight');assert.equal(r.status,200);assert.equal((await r.json()).estimateOnly,true);
 console.log('workerd: owner-only pricing check succeeds with fake provider and never generates video');
}finally{if(mf)await mf.dispose();await rm(tmp,{recursive:true,force:true})}
