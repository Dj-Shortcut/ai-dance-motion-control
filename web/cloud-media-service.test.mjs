import {test} from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createCloudMediaService} from './cloud-media-service.mjs';import {createAssets} from './assets.mjs';
const run=promisify(execFile),source=new URL('../rig-v4-runtime/fixtures/input.mp4',import.meta.url).pathname,secret='x'.repeat(40),owner='owner1',origin='https://rig.test';
async function files(){const dir=await mkdtemp(join(tmpdir(),'rig-media-int-'));try{const jpg=join(dir,'frame.jpg'),mp4=join(dir,'clip.mp4');await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-frames:v','1','-threads','1','-y',jpg]);await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-t','3','-vf','fps=30','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',mp4]);return {jpg:await readFile(jpg),mp4:await readFile(mp4)}}finally{await rm(dir,{recursive:true,force:true})}}
function memory(){const map=new Map();return {map,async head(k){return map.has(k)?{}:null},async delete(k){map.delete(k)},async put(k,b,o){if(map.has(k))return null;map.set(k,{bytes:new Uint8Array(b),customMetadata:o.customMetadata});return {key:k}},async get(k){const v=map.get(k);if(!v)return null;return {customMetadata:v.customMetadata,body:new Response(v.bytes).body}}}}
function bindings(f){const trace=[];return {trace,images:{input(){return {transform(options){trace.push(options);return {output:async()=>({response:()=>new Response(f.jpg,{headers:{'content-type':'image/jpeg'}})})}}}}},video:{input(){return {transform(){return {output(){return {response:async()=>new Response(f.mp4,{headers:{'content-type':'video/mp4'}})}}}}}}}}}
function setup(f){const bucket=memory(),b=bindings(f),handler=createCloudMediaService({secret,bucket,images:b.images,video:b.video,enabled:true});return {bucket,b,handler}}
const post=(path,bytes,user=owner,key=secret)=>new Request('https://rig-media.internal'+path,{method:'POST',headers:{authorization:`Bearer ${key}`,'x-rig-user':user,'content-type':'application/octet-stream'},body:bytes});
const get=(id,user=owner,key=secret)=>new Request('https://rig-media.internal/v1/assets/'+id,{headers:{authorization:`Bearer ${key}`,'x-rig-user':user}});
test('private service normalizes, stores, retrieves verified image and video and separates owners',async()=>{
 const f=await files(),{bucket,b,handler}=setup(f);
 assert.equal((await handler(post('/v1/normalize/image',f.jpg,owner,'wrong'))).status,401);
 let r=await handler(post('/v1/normalize/image',f.jpg));assert.equal(r.status,201);const image=await r.json();assert.equal(image.kind,'image');assert.equal(image.width,640);assert.equal(b.trace[0].metadata,'none');
 r=await handler(get(image.id));assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),f.jpg);
 assert.equal((await handler(get(image.id,'other'))).status,404);
 r=await handler(post('/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false',f.mp4));assert.equal(r.status,201);const video=await r.json();assert.equal(video.durationSeconds,3);assert.equal((await handler(get(video.id))).status,200);
 const stored=bucket.map.get(`rig-inputs/${owner}/${video.id}`);stored.bytes[stored.bytes.length-1]^=1;assert.equal((await handler(get(video.id))).status,503);
 const mismatched=await handler(post('/v1/normalize/video?durationSeconds=4&startSeconds=0&keepSound=false',f.mp4));assert.equal(mismatched.status,422);assert.equal(mismatched.headers.get('x-rig-media-uncertain'),null);
});
test('a verified 30-second video passes the assets and private media limits; 31 seconds does not',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-media-thirty-'));try{
  const path=join(dir,'thirty.mp4');await run('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','color=c=blue:s=360x360:r=30:d=30','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',path]);
  const bytes=await readFile(path),f=await files(),{handler,bucket}=setup({...f,mp4:bytes});
  const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:handler}});
  const request=seconds=>new Request(origin+'/api/assets',{method:'POST',headers:{origin,'x-rig-asset-kind':'video','content-type':'video/mp4','x-rig-duration-seconds':String(seconds),'x-rig-keep-sound':'false'},body:bytes});
  const r=await assets.handle(request(30));assert.equal(r.status,201,await r.clone().text());assert.equal((await r.json()).durationSeconds,30);assert.equal(bucket.map.size,1);
  assert.equal((await assets.handle(request(31))).status,400);assert.equal(bucket.map.size,1);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('real synthetic Cloudflare output retains its 29.968-second presentation duration through the private asset route',async()=>{
 const f=await files(),output=await readFile(new URL('./trial-fixtures/cloudflare-synthetic-blue-30.mp4',import.meta.url)),{handler,bucket}=setup({...f,mp4:output});
 let providerCalls=0;const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:handler},providerFetch:async()=>{providerCalls++;throw Error('unexpected fal call')}});
 const r=await assets.handle(new Request(origin+'/api/assets',{method:'POST',headers:{origin,'x-rig-asset-kind':'video','content-type':'video/mp4','x-rig-duration-seconds':'30','x-rig-keep-sound':'false'},body:f.mp4}));
 assert.equal(r.status,201,await r.clone().text());const result=await r.json();assert.equal(result.durationSeconds,29.968);assert.equal(Math.ceil(result.durationSeconds),30);assert.equal(bucket.map.size,1);assert.equal(providerCalls,0);
});
test('asset adapter obtains local verified manifest before confirmation without sending files to fal',async()=>{
 const f=await files(),{handler}=setup(f);let provider=0;
 const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:handler},providerFetch:async()=>{provider++;throw Error('unexpected provider')}});
 const req=new Request(origin+'/api/assets',{method:'POST',headers:{origin,'x-rig-asset-kind':'image','content-type':'image/jpeg'},body:f.jpg});const created=await assets.handle(req);assert.equal(created.status,201);const result=await created.json();
 const metadata=await assets.getOwned(owner,result.id);assert.equal(metadata.kind,'image');assert.equal(metadata.url,undefined);assert.equal(provider,0);
});
test('authenticated asset offset reaches the private transform and verified dimensions/fps survive storage',async()=>{
 const f=await files(),bucket=memory(),b=bindings(f),outputs=[];
 const video={input(){return {transform(){return {output(options){outputs.push(options);return {response:async()=>new Response(f.mp4,{headers:{'content-type':'video/mp4'}})}}}}}}};
 const handler=createCloudMediaService({secret,bucket,images:b.images,video,enabled:true});let provider=0;
 const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:handler},providerFetch:async()=>{provider++;throw Error('unexpected fal call')}});
 const request=start=>new Request(origin+'/api/assets',{method:'POST',headers:{origin,'content-type':'video/mp4','x-rig-asset-kind':'video','x-rig-duration-seconds':'3','x-rig-keep-sound':'false',...(start===undefined?{}:{'x-rig-start-seconds':start})},body:f.mp4});
 let r=await assets.handle(request('12.345'));assert.equal(r.status,201,await r.clone().text());const created=await r.json();assert.equal(outputs[0].time,'12.345s');
 const metadata=await assets.getOwned(owner,created.id);assert.equal(metadata.durationVerified,true);assert.equal(metadata.durationSeconds,3);assert.equal(metadata.width,640);assert.equal(metadata.height,480);assert.equal(metadata.fps,30);assert.equal(metadata.url,undefined);assert.equal(provider,0);
 r=await handler(get(created.id));assert.equal(r.headers.get('x-rig-fps'),'30');assert.equal(r.headers.get('x-rig-width'),'640');
 for(const invalid of ['-1','3600.001','1.0001','1e2','01','NaN'])assert.equal((await assets.handle(request(invalid))).status,400);
 assert.equal(outputs.length,1);assert.equal(provider,0);
 r=await assets.handle(request());assert.equal(r.status,201);assert.equal(outputs[1].time,'0s');
 for(const invalid of ['-1','3601','1.0001','0&startSeconds=1'])assert.equal((await handler(post(`/v1/normalize/video?durationSeconds=3&startSeconds=${invalid}&keepSound=false`,f.mp4))).status,422);
 assert.equal(outputs.length,2);
});
test('failed private storage verification deletes its test object and expired assets cannot be fetched',async()=>{
 const f=await files(),bucket=memory(),b=bindings(f),read=bucket.get;
 let failFirst=true;bucket.get=async key=>failFirst?(failFirst=false,null):read.call(bucket,key);
 const handler=createCloudMediaService({secret,bucket,images:b.images,video:b.video,enabled:true});
 assert.equal((await handler(post('/v1/normalize/image',f.jpg))).status,422);assert.equal(bucket.map.size,0);
 let r=await handler(post('/v1/normalize/image',f.jpg));assert.equal(r.status,201);let m=await r.json(),entry=bucket.map.get(`rig-inputs/${owner}/${m.id}`),stored=JSON.parse(entry.customMetadata.manifest);stored.expiresAt=Date.now()-1;entry.customMetadata.manifest=JSON.stringify(stored);
 assert.equal((await handler(get(m.id))).status,404);assert.equal(bucket.map.size,0);
});
test('ambiguous R2 put tries cleanup and retains an uncertainty marker',async()=>{
 const f=await files(),bucket=memory(),b=bindings(f),put=bucket.put;
 bucket.put=async(...args)=>{await put.apply(bucket,args);throw Error('uncertain put')};
 const handler=createCloudMediaService({secret,bucket,images:b.images,video:b.video,enabled:true});const response=await handler(post('/v1/normalize/image',f.jpg));
 assert.equal(response.status,422);assert.equal(response.headers.get('x-rig-media-uncertain'),'1');assert.equal(bucket.map.size,0);
});
test('explicit owner trial validates a transformed asset then removes and verifies its R2 object',async()=>{
 const f=await files(),{bucket,handler}=setup(f);const req=post('/v1/normalize/image',f.jpg);req.headers.set('x-rig-ephemeral-test','1');const r=await handler(req);assert.equal(r.status,201);const m=await r.json();assert.equal(m.cleanup,'ok');assert.equal(bucket.map.size,0);
});
test('explicit trial does not claim cleanup when delete or verification fails',async()=>{
 const f=await files(),{bucket,b,handler}=setup(f);bucket.delete=async()=>{throw Error('delete unavailable')};const req=post('/v1/normalize/image',f.jpg);req.headers.set('x-rig-ephemeral-test','1');const r=await handler(req);assert.equal(r.status,422);assert.equal(r.headers.get('x-rig-media-uncertain'),'1');assert.equal(bucket.map.size,1);
});
test('video diagnostic categories are bounded and never disclose provider errors',async()=>{
 const f=await files(),bucket=memory(),b=bindings(f);
 const badVideo={input:()=>({transform:()=>({output:()=>({response:async()=>new Response(new Uint8Array(64),{headers:{'content-type':'video/mp4'}})})})})};
 let handler=createCloudMediaService({secret,bucket,images:b.images,video:badVideo,enabled:true});
 let result=await handler(post('/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false',f.mp4));
 assert.equal(result.status,422);assert.equal(result.headers.get('x-rig-media-diagnostic'),'video_format');assert.equal(result.headers.get('x-rig-media-uncertain'),null);
 const failingVideo={input(){throw Error('private provider secret and user data')}};
 handler=createCloudMediaService({secret,bucket,images:b.images,video:failingVideo,enabled:true});
 result=await handler(post('/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false',f.mp4));
 assert.equal(result.headers.get('x-rig-media-diagnostic'),'video_transform');assert.equal(result.headers.get('x-rig-media-uncertain'),'1');assert.ok(!(await result.text()).includes('private provider secret'));
});
test('diagnostic capture is owner-only, private, bounded and never overwrites the first output',async()=>{
 const f=await files(),bad=Buffer.from(f.mp4),at=bad.indexOf('mdhd'),scale=bad.readUInt32BE(at+16);bad.writeUInt32BE(bad.readUInt32BE(at+20)+Math.ceil(scale/2),at+20);
 const bucket=memory(),b=bindings({...f,mp4:bad});const mk=(opts={})=>createCloudMediaService({secret,bucket,images:b.images,video:b.video,enabled:true,...opts});
 const path='/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false';
 let r=await mk()(post(path,f.mp4));assert.equal(r.status,422);assert.equal(bucket.map.size,0);
 const enabled=mk({diagnosticEnabled:true,diagnosticOwner:owner});
 r=await enabled(post(path,f.mp4,'other'));assert.equal(r.status,422);assert.equal(bucket.map.size,0);
 const ephemeral=post(path,f.mp4);ephemeral.headers.set('x-rig-ephemeral-test','1');r=await enabled(ephemeral);assert.equal(r.status,422);assert.equal(bucket.map.size,0);
 r=await enabled(post(path,f.mp4));assert.equal(r.status,422);assert.equal(r.headers.get('x-rig-media-diagnostic'),'video_capture_saved');assert.equal(r.headers.get('x-rig-media-uncertain'),null);
 const key=`rig-inputs/diagnostics/${owner}/rejected-video.mp4`;assert.deepEqual(Buffer.from(bucket.map.get(key).bytes),bad);assert.equal(bucket.map.size,1);
 r=await enabled(post(path,f.mp4));assert.equal(r.status,422);assert.equal(r.headers.get('x-rig-media-diagnostic'),'video_capture_exists');assert.deepEqual(Buffer.from(bucket.map.get(key).bytes),bad);assert.equal(bucket.map.size,1);
 assert.equal((await enabled(get('00000000-0000-4000-8000-000000000000'))).status,404);
});
test('uncertain diagnostic write is reported without leaking bytes',async()=>{
 const f=await files(),bad=Buffer.from(f.mp4),at=bad.indexOf('mdhd'),scale=bad.readUInt32BE(at+16);bad.writeUInt32BE(bad.readUInt32BE(at+20)+Math.ceil(scale/2),at+20);
 const bucket=memory();bucket.put=async()=>{throw Error('secret or video bytes must not leak')};const b=bindings({...f,mp4:bad});
 const handler=createCloudMediaService({secret,bucket,images:b.images,video:b.video,enabled:true,diagnosticEnabled:true,diagnosticOwner:owner});
 const r=await handler(post('/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false',f.mp4));assert.equal(r.status,422);assert.equal(r.headers.get('x-rig-media-diagnostic'),'video_capture_uncertain');assert.equal(r.headers.get('x-rig-media-uncertain'),'1');assert.ok(!(await r.text()).includes('secret or video bytes'));
});
test('successful transforms and unsettled provider failures do not create diagnostics',async()=>{
 const f=await files(),bucket=memory(),b=bindings(f),settings={secret,bucket,images:b.images,enabled:true,diagnosticEnabled:true,diagnosticOwner:owner};
 const path='/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false';
 let handler=createCloudMediaService({...settings,video:b.video});let r=await handler(post(path,f.mp4));assert.equal(r.status,201);assert.ok(!bucket.map.has(`rig-inputs/diagnostics/${owner}/rejected-video.mp4`));
 const failing={input(){throw Error('private service unavailable')}};handler=createCloudMediaService({...settings,video:failing});r=await handler(post(path,f.mp4));assert.equal(r.status,422);assert.equal(r.headers.get('x-rig-media-uncertain'),'1');assert.ok(!bucket.map.has(`rig-inputs/diagnostics/${owner}/rejected-video.mp4`));
});
test('owner can receive multiple bounded check categories for one rejected transcode without retaining it',async()=>{
 const f=await files(),bad=Buffer.from(f.mp4),mdhd=bad.indexOf('mdhd'),elst=bad.indexOf('elst');assert.ok(mdhd>0&&elst>0);
 const scale=bad.readUInt32BE(mdhd+16);bad.writeUInt32BE(bad.readUInt32BE(mdhd+20)+Math.ceil(scale/2),mdhd+20);bad.writeInt32BE(-1,elst+16);bad.writeUInt16BE(0,elst+20);
 const bucket=memory(),b=bindings({...f,mp4:bad}),settings={secret,bucket,images:b.images,video:b.video,enabled:true,summaryEnabled:true,diagnosticOwner:owner};
 const handler=createCloudMediaService(settings),path='/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false';
 let r=await handler(post(path,f.mp4));assert.equal(r.status,422);const checks=r.headers.get('x-rig-media-checks').split(',');
 for(const code of ['duration','edit_start','edit_rate'])assert.ok(checks.includes(code));assert.equal(bucket.map.size,0);
 r=await handler(post(path,f.mp4,'other'));assert.equal(r.headers.get('x-rig-media-checks'),null);
 const transient=post(path,f.mp4);transient.headers.set('x-rig-ephemeral-test','1');r=await handler(transient);assert.equal(r.headers.get('x-rig-media-checks'),null);
 const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:handler}});
 const ar=await assets.handle(new Request(origin+'/api/assets',{method:'POST',headers:{origin,'x-rig-asset-kind':'video','content-type':'video/mp4','x-rig-duration-seconds':'3','x-rig-keep-sound':'false'},body:f.mp4}));
 assert.equal(ar.status,503);const text=(await ar.json()).error;assert.match(text,/duur/);assert.match(text,/begin van tijdspoor/);assert.match(text,/snelheid van tijdspoor/);assert.equal(bucket.map.size,0);
});
test('asset endpoint exposes only allowlisted diagnostics and preserves uncertainty',async()=>{
 const f=await files();let code='fps';
 const media={fetch:async()=>new Response('private body',{status:422,headers:{'x-rig-media-diagnostic':code,'x-rig-media-uncertain':'1'}})};
 const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media});
 const request=()=>new Request(origin+'/api/assets',{method:'POST',headers:{origin,'x-rig-asset-kind':'video','content-type':'video/mp4','x-rig-duration-seconds':'3','x-rig-keep-sound':'false'},body:f.mp4});
 let result=await assets.handle(request());assert.equal(result.status,503);assert.equal(result.headers.get('x-rig-media-uncertain'),'1');assert.match((await result.json()).error,/beeldsnelheid/);
 code='private provider secret';result=await assets.handle(request());const body=await result.text();assert.ok(!body.includes('private provider secret'));assert.ok(!body.includes('private body'));
});
test('short output reports only validated numeric timing after a settled transform',async()=>{
 const f=await files(),bad=Buffer.from(f.mp4),at=bad.indexOf('mdhd'),scale=bad.readUInt32BE(at+16),duration=bad.readUInt32BE(at+20);bad.writeUInt32BE(duration-1,at+20);
 const {handler,bucket}=setup({...f,mp4:bad});const path='/v1/normalize/video?durationSeconds=3&startSeconds=0&keepSound=false';
 const result=await handler(post(path,f.mp4));assert.equal(result.status,422);assert.equal(result.headers.get('x-rig-media-diagnostic'),'duration_short');assert.equal(result.headers.get('x-rig-media-settled'),'1');assert.equal(result.headers.get('x-rig-media-uncertain'),null);
 assert.equal(Number(result.headers.get('x-rig-media-sample-seconds')),3);assert.ok(Math.abs(Number(result.headers.get('x-rig-media-header-seconds'))-(duration-1)/scale)<1e-11);assert.equal(result.headers.get('x-rig-media-frame-count'),'90');assert.equal(bucket.map.size,0);
 const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:handler}});
 const response=await assets.handle(new Request(origin+'/api/assets',{method:'POST',headers:{origin,'x-rig-asset-kind':'video','content-type':'video/mp4','x-rig-duration-seconds':'3','x-rig-keep-sound':'false'},body:f.mp4}));
 assert.equal(response.status,503);const data=await response.json();assert.match(data.error,/korter dan drie seconden/);assert.match(data.error,/Beeldtijd: 3 s/);assert.match(data.error,/videoheader: 2,\d+ s/);assert.match(data.error,/90 beelden/);assert.equal(bucket.map.size,0);
});
test('untrusted or uncertain diagnostic headers never become user-facing timing',async()=>{
 const f=await files();
 for(const headers of [
  {'x-rig-media-diagnostic':'duration_short','x-rig-media-settled':'1','x-rig-media-sample-seconds':'private-secret','x-rig-media-header-seconds':'2.900000000000','x-rig-media-frame-count':'90'},
  {'x-rig-media-diagnostic':'duration_short','x-rig-media-uncertain':'1','x-rig-media-settled':'1','x-rig-media-sample-seconds':'2.900000000000','x-rig-media-header-seconds':'2.900000000000','x-rig-media-frame-count':'90'},
  {'x-rig-media-diagnostic':'fps','x-rig-media-settled':'1','x-rig-media-sample-seconds':'2.900000000000','x-rig-media-header-seconds':'2.900000000000','x-rig-media-frame-count':'90'},
  {'x-rig-media-diagnostic':'duration_short','x-rig-media-settled':'1','x-rig-media-sample-seconds':'2.900000000000','x-rig-media-header-seconds':'2.900000000000','x-rig-media-frame-count':'9999'}
 ]){
  const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:async()=>new Response('private body',{status:422,headers})}});
  const response=await assets.handle(new Request(origin+'/api/assets',{method:'POST',headers:{origin,'x-rig-asset-kind':'video','content-type':'video/mp4','x-rig-duration-seconds':'3','x-rig-keep-sound':'false'},body:f.mp4}));const body=await response.text();assert.doesNotMatch(body,/Beeldtijd|private-secret|private body/);
 }
});
test('minor timing mismatch uses the higher measured duration; larger mismatch fails closed',async()=>{
 const f=await files(),at=f.mp4.indexOf('mdhd');assert.ok(at>0);const duration=f.mp4.readUInt32BE(at+20),scale=f.mp4.readUInt32BE(at+16);
 for(const [delta,message] of [[1,null],[Math.ceil(scale/2),/komt niet overeen/]]){
  const modified=Buffer.from(f.mp4);modified.writeUInt32BE(duration+delta,at+20);
  const {handler,bucket}=setup({...f,mp4:modified});
  const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:handler}});
  const r=await assets.handle(new Request(origin+'/api/assets',{method:'POST',headers:{origin,'x-rig-asset-kind':'video','content-type':'video/mp4','x-rig-duration-seconds':'3','x-rig-keep-sound':'false'},body:f.mp4}));
  if(message){assert.equal(r.status,503);assert.match((await r.json()).error,message);assert.equal(bucket.map.size,0)}
  else{assert.equal(r.status,201);const body=await r.json();assert.equal(body.durationSeconds,3+1/scale);assert.equal(bucket.map.size,1)}
 }
});
test('media service connection and invalid responses receive safe distinct messages and remain uncertain',async()=>{
 for(const [response,expected] of [[async()=>{throw Error('private-secret')},'De verbinding met de privé-mediadienst is mislukt.'],[async()=>new Response('private-secret',{status:201}),'Het antwoord van de privé-mediadienst kon niet worden gelezen.']]){
  const assets=createAssets({mode:'test',origin,mediaSecret:secret,falKey:'fake',limit:async()=>true,authenticate:async()=>({id:owner}),media:{fetch:response}});
  const result=await assets.handle(new Request(origin+'/api/assets',{method:'POST',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:new Uint8Array(64)}));
  assert.equal(result.status,503);assert.equal(result.headers.get('x-rig-media-uncertain'),'1');assert.equal((await result.json()).error,expected);
 }
});
