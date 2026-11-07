import {createRequire} from 'node:module';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
const req=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json'),{build}=req('esbuild'),{Miniflare}=req('miniflare'),run=promisify(execFile),dir=await mkdtemp(join(process.cwd(),'.rig-cloud-media-'));let mf;
try{
 const source=new URL('../rig-v4-runtime/fixtures/input.mp4',import.meta.url).pathname,jpg=join(dir,'f.jpg'),mp4=join(dir,'v.mp4'),bundle=join(dir,'worker.mjs');
 await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-frames:v','1','-threads','1','-y',jpg]);await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-t','3','-vf','fps=30','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',mp4]);
 await build({entryPoints:['cloud-media-workerd-fixture.mjs'],outfile:bundle,bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({modules:true,scriptPath:bundle,compatibilityDate:'2026-01-01',r2Buckets:['BUCKET']});
 const h={authorization:'Bearer '+'x'.repeat(40),'x-rig-user':'owner1','content-type':'application/octet-stream'};
 for(const [type,path,bytes] of [['image','/v1/normalize/image',await readFile(jpg)],['video','/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false',await readFile(mp4)]]){
  let r=await mf.dispatchFetch('https://service.internal'+path,{method:'POST',headers:h,body:bytes});assert.equal(r.status,201,await r.clone().text());const data=await r.json();assert.equal(data.kind,type);
  r=await mf.dispatchFetch('https://service.internal/v1/assets/'+data.id,{headers:h});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  r=await mf.dispatchFetch('https://service.internal/v1/assets/'+data.id,{headers:{...h,'x-rig-user':'other'}});assert.equal(r.status,404);
 }
 const fixture=await readFile(jpg);const trial=await mf.dispatchFetch('https://service.internal/v1/normalize/image',{method:'POST',headers:{...h,'x-rig-ephemeral-test':'1'},body:fixture});assert.equal(trial.status,201);const t=await trial.json();assert.equal(t.cleanup,'ok');const bucket=await mf.getR2Bucket('BUCKET');assert.equal(await bucket.head(`rig-inputs/owner1/${t.id}`),null);
 console.log('workerd: private image/video R2 round-trip, owner isolation, and trial cleanup succeeded; transforms mocked');
}finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
