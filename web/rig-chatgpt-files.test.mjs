import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createChatgptFilePreparer} from './rig-chatgpt-files.mjs';
const user='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',imageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',videoId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image=new Uint8Array(32).fill(1),video=new Uint8Array(64).fill(2);
const args={reference_file:{file_id:'file_photo',download_url:'https://files.oaiusercontent.com/photo?signature=image',mime_type:'image/jpeg'},motion_file:{file_id:'file_motion',download_url:'https://attachments.oaiusercontent.com/motion?signature=video',mime_type:'video/mp4'},seconds:5,startSeconds:12.345,quality:'edit-standard',keepSound:true,steadyCamera:false};
function fixture({cap={enabled:true,funding:'sponsored',qualities:['standard','pro','edit-standard']},allowance={state:'eligible',remainingCents:500},fetcher,upload,duration=5,downloadTimeoutMs=30000}={}){
 const calls=[],downloads=[];
 const ctx={userId:user,request:async(path,init={})=>{calls.push({path,init});if(path==='/api/video-config')return Response.json(cap);if(path==='/api/sponsor-invitations/status')return Response.json(allowance);if(path==='/api/assets'){
  const role=new Headers(init.headers).get('x-rig-asset-kind');return upload?upload(role,init):Response.json({status:'ready',kind:role,id:role==='image'?imageId:videoId,...(role==='video'?{durationSeconds:duration}:{})},{status:201});
 }throw Error('unexpected private path');}};
 const prepare=createChatgptFilePreparer({downloadTimeoutMs,fetchImpl:async(url,init)=>{downloads.push({url,init});return fetcher?fetcher(url,init):new Response(url.includes('/photo')?image:video,{headers:{'content-type':url.includes('/photo')?'image/jpeg':'video/mp4'}})}});
 return {ctx,calls,downloads,prepare};
}
test('native attachments are downloaded without account headers, then prepared through the own private API',async()=>{
 const f=fixture(),result=await f.prepare(f.ctx,args);assert.deepEqual(result,{imageId,videoId,durationSeconds:5});assert.equal(f.downloads.length,2);
 for(const call of f.downloads){assert.equal(call.init.method,'GET');assert.equal(call.init.redirect,'manual');assert.equal(call.init.credentials,'omit');assert.equal(call.init.cache,'no-store');assert.equal(call.init.referrerPolicy,'no-referrer');assert.ok(call.init.signal instanceof AbortSignal);assert.deepEqual([...new Headers(call.init.headers).keys()],['accept']);}
 assert.deepEqual(f.calls.map(x=>x.path),['/api/video-config','/api/sponsor-invitations/status','/api/assets','/api/assets']);
 const uploads=f.calls.filter(x=>x.path==='/api/assets');assert.deepEqual(uploads[0].init.body,image);assert.deepEqual(uploads[1].init.body,video);
 assert.equal(new Headers(uploads[0].init.headers).get('x-rig-asset-kind'),'image');const h=new Headers(uploads[1].init.headers);assert.equal(h.get('content-type'),'video/mp4');assert.equal(h.get('x-rig-duration-seconds'),'5');assert.equal(h.get('x-rig-start-seconds'),'12.345');assert.equal(h.get('x-rig-keep-sound'),'true');
 assert.ok(!JSON.stringify(result).includes('signature'));assert.ok(f.calls.every(x=>!x.path.includes('generation')));
});
test('only HTTPS OpenAI attachment subdomains with no userinfo, explicit port or fragment are accepted',async()=>{
 for(const url of ['https://example.com/photo','http://files.oaiusercontent.com/photo','https://oaiusercontent.com/photo','https://files.oaiusercontent.com.attacker.test/photo','https://files.oaiusercontent.com@attacker.test/photo','https://user@files.oaiusercontent.com/photo','https://files.oaiusercontent.com:443/photo','https://files.oaiusercontent.com:8443/photo','https://files.oaiusercontent.com/photo#private','file:///private/photo','https://127.0.0.1/photo','https://files.oaiusercontent.com\\@attacker.test/photo',' https://files.oaiusercontent.com/photo']){
  const f=fixture();await assert.rejects(f.prepare(f.ctx,{...args,reference_file:{...args.reference_file,download_url:url}}));assert.equal(f.downloads.length,0,url);assert.equal(f.calls.length,0,url);
 }
});
test('attachment descriptors, selection bounds and authenticated context cannot be replaced by arbitrary URL inputs',async()=>{
 for(const patch of [{reference_file:'https://files.oaiusercontent.com/photo'},{reference_file:{download_url:args.reference_file.download_url}},{motion_file:{...args.motion_file,file_id:'../secret'}},{reference_file:{...args.reference_file,url:'https://files.oaiusercontent.com/fallback'}},{url:'https://files.oaiusercontent.com/fallback'},{seconds:16},{seconds:2},{seconds:3.5},{startSeconds:-1},{startSeconds:3600.001},{startSeconds:0.0001},{quality:'unknown'},{keepSound:'yes'},{steadyCamera:true}]){
  const f=fixture();await assert.rejects(f.prepare(f.ctx,{...args,...patch}));assert.equal(f.downloads.length,0);assert.equal(f.calls.length,0);
 }
 for(const ctxPatch of [{userId:'spoofed'},{frozen:true},{session:{frozen:true}},{request:null}]){const f=fixture();await assert.rejects(f.prepare({...f.ctx,...ctxPatch},args));assert.equal(f.downloads.length,0);}
});
test('disabled current capability, missing edit activation or unavailable sponsor budget prevent all downloads',async()=>{
 for(const cap of [{enabled:false},{enabled:true,funding:'owner'},{enabled:true,funding:'other',qualities:['edit-standard']},{enabled:true,funding:'owner',qualities:['standard','pro']},{enabled:true,funding:'owner',qualities:['edit-standard','bogus']}]){
  const f=fixture({cap});await assert.rejects(f.prepare(f.ctx,args));assert.equal(f.downloads.length,0);assert.ok(f.calls.every(x=>x.path!=='/api/assets'));
 }
 for(const allowance of [{state:'unavailable'},{state:'eligible',remainingCents:0},{state:'eligible',remainingCents:501},{state:'eligible',remainingCents:NaN}]){const f=fixture({allowance});await assert.rejects(f.prepare(f.ctx,args));assert.equal(f.downloads.length,0);}
});
test('legacy capability supports only the two existing qualities and standard defaults keep offset zero',async()=>{
 const f=fixture({cap:{enabled:true,funding:'owner'}});const result=await f.prepare(f.ctx,{reference_file:args.reference_file,motion_file:args.motion_file,seconds:5});assert.equal(result.durationSeconds,5);assert.equal(f.calls.filter(x=>x.path==='/api/sponsor-invitations/status').length,0);
 const h=new Headers(f.calls.at(-1).init.headers);assert.equal(h.get('x-rig-start-seconds'),'0');assert.equal(h.get('x-rig-keep-sound'),'true');
});
test('redirects, forbidden MIME types, mismatched lengths and streamed size overflow never reach private upload',async()=>{
 const overflow=()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(16*1024*1024));c.enqueue(new Uint8Array(1));c.close()}}),{headers:{'content-type':'image/jpeg'}});
 for(const response of [()=>new Response(null,{status:302,headers:{location:'https://attacker.test/photo','content-type':'image/jpeg'}}),()=>new Response(image,{headers:{'content-type':'application/octet-stream'}}),()=>new Response(image,{headers:{'content-type':'text/html'}}),()=>new Response(image,{headers:{'content-type':'image/jpeg','content-length':'16777217'}}),()=>new Response(image,{headers:{'content-type':'image/jpeg','content-length':'10'}}),overflow]){
  const f=fixture({fetcher:response});await assert.rejects(f.prepare(f.ctx,args));assert.equal(f.calls.filter(x=>x.path==='/api/assets').length,0);assert.equal(f.downloads.length,1);
 }
});
test('a failed second download leaves no prepared first asset and never uses a fallback URL',async()=>{
 const f=fixture({fetcher:async url=>url.includes('/photo')?new Response(image,{headers:{'content-type':'image/jpeg'}}):new Response(null,{status:403})});await assert.rejects(f.prepare(f.ctx,args));assert.equal(f.downloads.length,2);assert.equal(f.calls.filter(x=>x.path==='/api/assets').length,0);
});
test('download deadline cancels a stalled body before private preparation',async()=>{
 let canceled=false;const f=fixture({downloadTimeoutMs:5,fetcher:()=>new Response(new ReadableStream({cancel(){canceled=true}}),{headers:{'content-type':'image/jpeg'}})});
 const keepAlive=setTimeout(()=>{},100);try{await assert.rejects(f.prepare(f.ctx,args));assert.equal(canceled,true);assert.equal(f.calls.filter(x=>x.path==='/api/assets').length,0)}finally{clearTimeout(keepAlive)}
});
test('only authoritative prepared duration and identifiers are returned; bad or failed preparation stops the flow',async()=>{
 const f=fixture({duration:5.04});assert.equal((await f.prepare(f.ctx,args)).durationSeconds,5.04);
 for(const duration of [2.99,5.2,15.01,NaN]){const bad=fixture({duration});await assert.rejects(bad.prepare(bad.ctx,args));assert.ok(bad.calls.every(x=>!x.path.includes('generation')));}
 const g=fixture({upload:async()=>Response.json({status:'ready',kind:'image',id:'not-a-uuid'})});await assert.rejects(g.prepare(g.ctx,args));assert.equal(g.calls.filter(x=>x.path==='/api/assets').length,1);
 const h=fixture({upload:async(role)=>role==='image'?Response.json({status:'ready',kind:'image',id:imageId}):Response.json({error:'private-provider-secret-detail'},{status:503})});await assert.rejects(h.prepare(h.ctx,args),e=>!e.message.includes('private-provider-secret-detail'));assert.ok(h.calls.every(x=>!x.path.includes('generation')));
});
