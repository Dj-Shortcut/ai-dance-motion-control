import {createRequire} from 'node:module';import {readFile,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');const {build}=require('esbuild'),{Miniflare}=require('miniflare');const run=promisify(execFile),dir=await mkdtemp(join(process.cwd(),'.rig-workerd-mp4-'));let mf;
try{
 const clip=join(dir,'clip.mp4'),bundle=join(dir,'worker.mjs');
 await run('ffmpeg',['-hide_banner','-v','error','-i',new URL('../rig-v4-runtime/fixtures/input.mp4',import.meta.url).pathname,'-t','3','-vf','fps=30','-c:v','libx264','-threads','2','-an','-movflags','+faststart','-y',clip]);
 await build({entryPoints:['inspect-worker-fixture.mjs'],outfile:bundle,bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({modules:true,scriptPath:bundle,compatibilityDate:'2026-01-01'});
 const bytes=await readFile(clip);const r=await mf.dispatchFetch('https://local.test',{method:'POST',body:bytes});assert.equal(r.status,200);const v=await r.json();assert.equal(v.durationSeconds,3);assert.equal(v.width,640);assert.equal(v.frameCount,90);
 const bad=await mf.dispatchFetch('https://local.test',{method:'POST',body:bytes.subarray(0,bytes.length-1)});assert.equal(bad.status,400);console.log('workerd accepts synthetic MP4 metadata and rejects truncated bytes');
}finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
