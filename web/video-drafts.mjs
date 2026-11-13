// Owned continuation metadata only. Never quotes, reserves credit or calls Fal.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER=/^[A-Za-z0-9_-]{1,100}$/,SHA=/^[a-f0-9]{64}$/;
const PREFIX='rig-video-drafts/v1/',TTL=86400000,MAX=16384;
const kinds=['standard','pro','edit-standard','human-recast'];
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; frame-ancestors 'none'"};
const json=(body,status=200)=>Response.json(body,{status,headers});
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const key=(user,quote)=>PREFIX+user+'/'+quote+'.json';
const exact=(o,required,optional=[])=>o&&typeof o==='object'&&!Array.isArray(o)&&required.every(k=>Object.hasOwn(o,k))&&Object.keys(o).every(k=>required.includes(k)||optional.includes(k));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function bytes(body,max=MAX){if(!body)throw fail('invalid_request',400);const reader=body.getReader(),parts=[];let size=0;const signal=AbortSignal.timeout(30000),abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});try{for(;;){if(signal.aborted)throw fail('unavailable',503);const chunk=await reader.read();if(signal.aborted)throw fail('unavailable',503);if(chunk.done)break;if(!(chunk.value instanceof Uint8Array)||size+chunk.value.length>max)throw fail('invalid_request',413);parts.push(chunk.value);size+=chunk.value.length;}const out=new Uint8Array(size);let n=0;for(const p of parts){out.set(p,n);n+=p.length;}return out;}finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});reader.releaseLock();}}
async function bodyJSON(body){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(body)));}catch(e){if(e?.status)throw e;throw fail('invalid_request',400);}}
function selection(raw,quote){
 const required=['quoteId','fullVideoId','imageId','selectedSeconds','quality','keepSound','prompt','cleanup','originalStartSeconds'];
 if(!exact(raw,required,['faceId','angleIds','steadyCamera','transferPolicy'])||![raw.quoteId,raw.fullVideoId,raw.imageId].every(x=>UUID.test(x||''))||!kinds.includes(raw.quality)||typeof raw.keepSound!=='boolean'||typeof raw.cleanup!=='boolean'||typeof raw.prompt!=='string'||raw.prompt.length>1900||!Number.isInteger(raw.selectedSeconds)||raw.selectedSeconds<3||raw.selectedSeconds>(['standard','pro'].includes(raw.quality)?30:15)||!Number.isFinite(raw.originalStartSeconds)||raw.originalStartSeconds<0||raw.originalStartSeconds>604800)throw fail('invalid_request',400);
 const d=quote?.input?.data;if(!d||quote.id!==raw.quoteId)throw fail('quote_mismatch');
 const request={imageId:raw.imageId,videoId:raw.fullVideoId,faceId:raw.faceId??null,angleIds:raw.angleIds??[],quality:raw.quality,keepSound:raw.keepSound,steadyCamera:raw.steadyCamera??d.steadyCamera,prompt:raw.prompt,...(raw.transferPolicy!==undefined?{transferPolicy:raw.transferPolicy}:{})};
 if(!Array.isArray(request.angleIds)||request.angleIds.length>3||![request.faceId,...request.angleIds].every(x=>x===null||UUID.test(x||''))||typeof request.steadyCamera!=='boolean')throw fail('invalid_request',400);
 for(const k of ['imageId','faceId','angleIds','quality','keepSound','steadyCamera','prompt','transferPolicy'])if(!equal(request[k],d[k]??(k==='faceId'?null:k==='angleIds'?[]:undefined)))throw fail('quote_mismatch');
 const cleanup=!!quote.input.workflow&&!!quote.input.cleanup;
 if(raw.cleanup!==cleanup||cleanup&&(quote.input.workflow.version!=='rig-workflow-v2'||request.quality!=='human-recast')||!cleanup&&quote.input.workflow)throw fail('quote_mismatch');
 return {request,selectedSeconds:raw.selectedSeconds,originalStartSeconds:raw.originalStartSeconds,cleanup};
}
function descriptor(asset){return {id:asset.id,kind:asset.kind,mime:asset.kind==='video'?'video/mp4':'image/jpeg',sha256:asset.sha256,size:asset.size,width:asset.width,height:asset.height,expiresAt:asset.expiresAt,...(asset.kind==='video'?{durationSeconds:asset.durationSeconds}:{})};}
function validAsset(a,id,kind,now){return a?.id===id&&a.kind===kind&&a.verified===true&&SHA.test(a.sha256||'')&&Number.isSafeInteger(a.size)&&a.size>0&&a.size<=16777216&&Number.isSafeInteger(a.expiresAt)&&a.expiresAt>now&&Number.isInteger(a.width)&&a.width>=340&&Number.isInteger(a.height)&&a.height>=340&&(kind!=='video'||a.durationVerified===true&&Number.isFinite(a.durationSeconds)&&a.durationSeconds>=3&&a.durationSeconds<=30);}
async function verifiedRefs(assets,user,s,quote,now){
 const list=[['image',s.request.imageId,'image'],['video',s.request.videoId,'video'],...(s.request.faceId?[['face',s.request.faceId,'image']]:[]),...s.request.angleIds.map((id,i)=>['angle'+i,id,'image'])],refs={};
 for(const [role,id,kind] of list){const a=await assets.getOwned(user,id);if(!validAsset(a,id,kind,now))throw fail('source_unavailable');if(role!=='video'&&!quote.input.refs?.some(ref=>ref.id===id&&ref.kind===kind&&ref.sha256===a.sha256))throw fail('quote_mismatch');refs[role]=descriptor(a);}
 const video=refs.video,max=['standard','pro'].includes(s.request.quality)?30:15;
 if(video.durationSeconds<=quote.durationSeconds||s.selectedSeconds<=Math.ceil(quote.durationSeconds)||Math.ceil(quote.durationSeconds)>(s.request.quality==='human-recast'?6:5)||video.durationSeconds>max||Math.ceil(video.durationSeconds)!==s.selectedSeconds||s.request.quality==='human-recast'&&video.durationSeconds<5)throw fail('invalid_full_duration');
 return refs;
}
async function stored(bucket,user,quote,now){const object=await bucket.get(key(user,quote));if(!object)return {missing:true};const record=await bodyJSON(object.body);if(record?.version!==1||record.userId!==user||record.quoteId!==quote||!Number.isSafeInteger(record.createdAt)||!Number.isSafeInteger(record.expiresAt)||record.expiresAt<=record.createdAt||record.expiresAt-record.createdAt>TTL||!record.selection||!record.refs)throw fail('unavailable',503);if(record.expiresAt<=now){await bucket.delete(key(user,quote));return {expired:true};}return {record};}
export function videoDraftPath(path,method){return method==='POST'&&path==='/api/video-drafts'||method==='GET'&&(/^\/api\/generations\/[0-9a-f-]{36}\/draft$/.test(path)||/^\/api\/video-drafts\/[0-9a-f-]{36}\/assets\/[0-9a-f-]{36}$/.test(path));}
export function createVideoDraftHandler({bucket,assets,quotes,jobs,authenticate,trustedOrigin,clock=Date.now}){
 return async req=>{
  const u=new URL(req.url);if(!videoDraftPath(u.pathname,req.method))return null;
  try{
   if(u.search||u.origin!==trustedOrigin||req.method==='POST'&&req.headers.get('origin')!==trustedOrigin)return json({error:'Aanvraag geweigerd.'},403);
   const user=(await authenticate(req))?.id;if(!USER.test(user||''))return json({error:'Aanmelden vereist.'},401);
   if(!bucket?.get||!bucket?.put||!bucket?.delete||!assets?.getOwned||!assets?.readOwned)throw fail('unavailable',503);
   const now=clock();
   if(req.method==='POST'){
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))throw fail('invalid_request',400);
    const raw=await bodyJSON(req.body);if(!UUID.test(raw?.quoteId||''))throw fail('invalid_request',400);const quote=await quotes.getOwned(user,raw.quoteId);if(!quote||quote.userId!==user||quote.expiresAt<=now)throw fail('quote_unavailable');
    const selected=selection(raw,quote),refs=await verifiedRefs(assets,user,selected,quote,now),expiresAt=Math.min(now+TTL,...Object.values(refs).map(a=>a.expiresAt));
    const existing=await stored(bucket,user,quote.id,now);if(existing.record){if(!equal(existing.record.selection,selected)||!equal(existing.record.refs,refs))throw fail('draft_conflict');return json({saved:true,expiresAt:existing.record.expiresAt});}
    const record={version:1,userId:user,quoteId:quote.id,createdAt:now,expiresAt,selection:selected,refs},value=JSON.stringify(record);if(value.length>MAX)throw fail('invalid_request',413);
    const wrote=await bucket.put(key(user,quote.id),value,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
    if(!wrote){const replay=await stored(bucket,user,quote.id,now);if(!replay.record||!equal(replay.record.selection,selected)||!equal(replay.record.refs,refs))throw fail('draft_conflict');return json({saved:true,expiresAt:replay.record.expiresAt});}
    return json({saved:true,expiresAt},201);
   }
   const jobMatch=/^\/api\/generations\/([^/]+)\/draft$/.exec(u.pathname),assetMatch=/^\/api\/video-drafts\/([^/]+)\/assets\/([^/]+)$/.exec(u.pathname);
   let quoteId,job;if(jobMatch){if(!UUID.test(jobMatch[1]))throw fail('not_found',404);job=await jobs.getOwned(user,jobMatch[1]);if(!job||job.userId!==user||job.state!=='completed')throw fail('not_found',404);quoteId=job.quoteId;}else{quoteId=assetMatch[1];if(!UUID.test(quoteId)||!UUID.test(assetMatch[2]))throw fail('not_found',404);}
   const quote=await quotes.getOwned(user,quoteId);if(!quote||quote.userId!==user)throw fail('not_found',404);
   const loaded=await stored(bucket,user,quoteId,now);if(!loaded.record)return jobMatch?json({available:false,reason:loaded.expired?'expired':'missing'}):json({error:'Bestand niet beschikbaar.'},404);
   const record=loaded.record,s=record.selection;
   const {videoId,...original}=s.request;selection({quoteId,fullVideoId:videoId,...original,selectedSeconds:s.selectedSeconds,originalStartSeconds:s.originalStartSeconds,cleanup:s.cleanup},quote);
   if(assetMatch){const allowed=[s.request.imageId,s.request.videoId,...(s.request.faceId?[s.request.faceId]:[]),...s.request.angleIds];if(!allowed.includes(assetMatch[2]))throw fail('not_found',404);const ref=Object.values(record.refs).find(a=>a?.id===assetMatch[2]);if(!ref)throw fail('not_found',404);const owned=await assets.readOwned(user,ref.id,ref.sha256);if(!validAsset(owned,ref.id,ref.kind,now)||!owned.bytes||!equal(descriptor(owned),ref))throw fail('source_unavailable');return new Response(owned.bytes,{headers:{...headers,'content-type':ref.mime,'content-length':String(ref.size)}});}
   let refs;try{refs=await verifiedRefs(assets,user,s,quote,now);if(!equal(refs,record.refs))throw Error('changed');}catch{return jobMatch?json({available:false,reason:'source_unavailable'}):json({error:'Bestand niet beschikbaar.'},404);}
   const publicAsset=a=>{const {kind,expiresAt,...rest}=a;return {...rest,path:`/api/video-drafts/${quoteId}/assets/${a.id}`};};
   if(jobMatch)return json({available:true,expiresAt:record.expiresAt,request:s.request,durationSeconds:refs.video.durationSeconds,selectedSeconds:s.selectedSeconds,originalStartSeconds:s.originalStartSeconds,cleanup:s.cleanup,assets:{image:publicAsset(refs.image),video:publicAsset(refs.video),face:refs.face?publicAsset(refs.face):null,angles:s.request.angleIds.map((_,i)=>publicAsset(refs['angle'+i]))}});
   throw fail('not_found',404);
  }catch(e){return json({error:e?.status===404?'Niet gevonden.':'Je bewaarde bestanden zijn niet beschikbaar. Er is geen video gestart.',code:['invalid_request','quote_mismatch','draft_conflict','quote_unavailable','invalid_full_duration','source_unavailable'].includes(e?.code)?e.code:'draft_unavailable'},[400,401,403,404,409,413].includes(e?.status)?e.status:503);}
 };
}
// Logical access expires exactly on expiresAt. This bounded scheduled sweep is
// eventual physical metadata cleanup, not a promise of deletion at that instant.
export async function collectVideoDrafts(bucket,{now=Date.now(),limit=4}={}){
 const stats={checked:0,deleted:0};if(!bucket?.list||!bucket?.get||!bucket?.put||!bucket?.delete)return stats;
 const cursorKey='rig-video-draft-gc/v1/cursor.json',prior=await bucket.get(cursorKey);let cursor=null;
 if(prior){const saved=await bodyJSON(prior.body);if(saved?.version!==1||saved.cursor!==null&&(typeof saved.cursor!=='string'||saved.cursor.length>4096))throw Error('Invalid private draft GC cursor');cursor=saved.cursor;}
 const page=await bucket.list({prefix:PREFIX,limit:Math.min(20,Math.max(1,limit)),...(cursor?{cursor}:{})});
 for(const item of page.objects??[]){if(!new RegExp('^'+PREFIX+'[A-Za-z0-9_-]{1,100}/[0-9a-f-]{36}\\.json$').test(item.key))continue;stats.checked++;try{const obj=await bucket.get(item.key);if(!obj)continue;const value=await bodyJSON(obj.body);if(value?.version===1&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt<=now){await bucket.delete(item.key);stats.deleted++;}}catch{}}
 const next=page.truncated&&typeof page.cursor==='string'&&page.cursor.length<=4096?page.cursor:null;
 // Concurrent collectors may duplicate harmless reads/deletes, but never
 // overwrite a newer scan cursor. Every page remains under the fixed prefix.
 await bucket.put(cursorKey,JSON.stringify({version:1,cursor:next}),{onlyIf:prior?.etag?{etagMatches:prior.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
 return stats;
}
