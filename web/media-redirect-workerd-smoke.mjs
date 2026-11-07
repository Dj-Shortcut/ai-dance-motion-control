// Local-only Cloudflare runtime check, with synthetic provider responses.
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');
const {build}=require('esbuild'),{Miniflare}=require('miniflare');
const tmp=await mkdtemp(join(process.cwd(),'.rig-media-smoke-'));let mf;
try{
 const bundle=join(tmp,'worker.mjs');
 await build({entryPoints:['media-redirect-workerd-fixture.mjs'],outfile:bundle,bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({modules:true,scriptPath:bundle,compatibilityDate:'2026-01-01'});
 const r=await mf.dispatchFetch('https://owner.example/');assert.equal(r.status,200);assert.equal(await r.text(),'redirects rejected');
 console.log('workerd: all seven mocked upload redirects rejected, including anonymous and signed input checks');
}finally{if(mf)await mf.dispose();await rm(tmp,{recursive:true,force:true})}
