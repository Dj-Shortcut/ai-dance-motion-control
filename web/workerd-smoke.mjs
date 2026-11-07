// Real Cloudflare workerd, isolated local test. Uses existing Miniflare/esbuild
// from the workspace; never contacts Cloudflare, Mollie, fal, or a real secret.
import {createRequire} from 'node:module';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const depRoot='/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json';
const require=createRequire(depRoot);
const {build}=require('esbuild');const {Miniflare}=require('miniflare');
const tmp=await mkdtemp(join(process.cwd(),'.rig-workerd-'));let mf;
try {
 const bundle=join(tmp,'ingress.mjs'),backendBundle=join(tmp,'backend.mjs');
 await build({entryPoints:['workerd-fixtures/backend.mjs'],outfile:backendBundle,bundle:true,format:'esm',platform:'browser'});
 await build({entryPoints:['workerd-fixtures/ingress.mjs'],outfile:bundle,bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({workers:[
  {name:'ingress',modules:true,scriptPath:bundle,compatibilityDate:'2026-01-01',serviceBindings:{RIG_STAGING_SERVICE:'backend'}},
  {name:'backend',modules:true,scriptPath:backendBundle,compatibilityDate:'2026-01-01',serviceBindings:{MOCK_MOLLIE:'mock-mollie'}},{name:'mock-mollie',modules:true,scriptPath:'workerd-fixtures/mollie.mjs',compatibilityDate:'2026-01-01'}
 ]});
 let response=await mf.dispatchFetch('https://rig.example/api/payments/balance');
 assert.equal(response.status,200);assert.equal((await response.json()).balance,0);
 response=await mf.dispatchFetch('https://rig.example/api/payments/create');
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{redirectRefused:true,calls:1});
 response=await mf.dispatchFetch('https://rig.example/api/payments/packages');
 assert.equal(response.status,503,'a backend redirect must not be followed');
 await mf.dispose();mf=undefined;
 const oldBundle=join(tmp,'old-ingress.mjs');
 await build({entryPoints:['workerd-fixtures/ingress.mjs'],outfile:oldBundle,bundle:true,format:'esm',platform:'browser',plugins:[{name:'reproduce-old-mode',setup(b){b.onLoad({filter:/sites-signer\.mjs$/},async args=>({contents:(await readFile(args.path,'utf8')).replace("redirect:'manual'","redirect:'error'"),loader:'js'}))}}]});
 mf=new Miniflare({workers:[{name:'ingress',modules:true,scriptPath:oldBundle,compatibilityDate:'2026-01-01',serviceBindings:{RIG_STAGING_SERVICE:'backend'}},{name:'backend',modules:true,scriptPath:backendBundle,compatibilityDate:'2026-01-01',serviceBindings:{MOCK_MOLLIE:'mock-mollie'}},{name:'mock-mollie',modules:true,scriptPath:'workerd-fixtures/mollie.mjs',compatibilityDate:'2026-01-01'}]});
 response=await mf.dispatchFetch('https://rig.example/api/payments/balance');
 assert.equal(response.status,503,'the previous redirect mode must reproduce the runtime failure');
 console.log('workerd service binding: old mode fails; signed request succeeds with manual; backend and Mollie redirects fail closed');
}finally{if(mf)await mf.dispose();await rm(tmp,{recursive:true,force:true})}
