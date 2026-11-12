// Private, exact working clips and paired masks. No provider calls or public
// URLs. The HTTP caller must authenticate a signed subject, hold the shared
// media lease and impose its transport body limit before calling this store.
import {isProductionGenerationContext,productionFundingKind} from './production-generation-context.mjs';
import {inspectWorkflowMp4} from './workflow-mp4-inspect.mjs';
import {workflowClientMedia} from './workflow-client-contract.mjs';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,SHA=/^[a-f0-9]{64}$/;
const PREFIX='rig-workflow-inputs/',LIFETIME=86400000,MAX=16*1024*1024,MASK_MAX=2*1024*1024;
const key=(user,id)=>`${PREFIX}${user}/${id}.mp4`;
const compact=m=>({sha256:m.sha256,size:m.size,geometryVerified:m.geometryVerified,...workflowClientMedia(m)});
function validRecord(m,user,id){return m?.version==='rig-workflow-input-v1'&&m.id===id&&m.userId===user&&['source','mask'].includes(m.kind)&&SHA.test(m.media?.sha256||'')&&Number.isSafeInteger(m.media.size)&&m.media.size>=32&&m.media.size<=(m.kind==='mask'?MASK_MAX:MAX)&&Number.isSafeInteger(m.createdAt)&&Number.isSafeInteger(m.expiresAt)&&m.expiresAt-m.createdAt===LIFETIME&&(m.kind==='source'?m.source===null:UUID.test(m.source?.id||'')&&SHA.test(m.source?.sha256||''));}
const sameMedia=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function publicManifest(m){const g=m.media;return {version:'rig-owned-cleanup-source-v1',id:m.id,sha256:g.sha256,size:g.size,width:g.width,height:g.height,rotation:0,hasAudio:g.hasAudio,clock:{timescale:g.fpsNumerator,firstPts:0,frameDelta:g.fpsDenominator,frameCount:g.frameCount}};}
async function readHeld(body,max){
 if(!body?.getReader)throw Error('Private workflow body missing');
 const r=body.getReader(),parts=[];let total=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Private workflow read timed out')),15000)});
 try{for(;;){const {done,value}=await Promise.race([r.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array)||!value.length||parts.length>=1024||total+value.length>max)throw Error('Invalid private workflow read');parts.push(value);total+=value.length}const bytes=new Uint8Array(total);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}return bytes;}
 finally{clearTimeout(timer);void r.cancel().catch(()=>{});r.releaseLock();}
}

export function createWorkflowInputStore({productionContext,readCurrentProductionContext,bucket,reservePreparation,allowRead,clock=Date.now}={}){
 if(!isProductionGenerationContext(productionContext)||typeof readCurrentProductionContext!=='function'||!bucket||['put','get','head'].some(k=>typeof bucket[k]!=='function')||typeof reservePreparation!=='function'||typeof allowRead!=='function')throw Error('Private workflow inputs unavailable');
 const db=productionContext.env.DB;
 async function owner(user){
  if(!USER.test(user||'')||productionContext.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED!=='yes'||productionFundingKind(productionContext,user)!=='owner-provider')throw Error('Cleanup preparation unavailable');
  const current=await readCurrentProductionContext();
  if(!isProductionGenerationContext(current,{db,origin:productionContext.env.RIG_PUBLIC_ORIGIN})||current.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED!=='yes'||productionFundingKind(current,user)!=='owner-provider')throw Error('Cleanup preparation unavailable');
 }
 function time(){const now=clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid workflow time');return now;}
 async function get({userId,id,expectedSha256}={}){
  if(!USER.test(userId||'')||!UUID.test(id||'')||expectedSha256!==undefined&&!SHA.test(expectedSha256))throw Error('Invalid owned workflow reference');
  if(await allowRead({userId,id})!==true)throw Error('Workflow read limited');
  const object=await bucket.get(key(userId,id));if(!object)throw Error('Owned workflow input missing');
  const metadata=object.customMetadata?.manifest;
  if(typeof metadata!=='string'||metadata.length>8192)throw Error('Invalid workflow metadata');
  const record=JSON.parse(metadata);if(!validRecord(record,userId,id)||record.expiresAt<=time()||record.createdAt>time()+1000||expectedSha256!==undefined&&record.media.sha256!==expectedSha256||object.httpMetadata?.contentType!=='video/mp4'||object.httpMetadata?.cacheControl!=='private, no-store')throw Error('Owned workflow input expired or changed');
  const bytes=await readHeld(object.body,record.kind==='mask'?MASK_MAX:MAX),inspection=await inspectWorkflowMp4(bytes,{role:record.kind==='mask'?'mask':'input'});
  if(!sameMedia(compact(inspection),record.media))throw Error('Workflow input integrity mismatch');
  return {record,bytes,inspection,manifest:publicManifest(record)};
 }
 async function put(userId,kind,bytes,source=null){
  await owner(userId);
  if(!(bytes instanceof Uint8Array)||typeof SharedArrayBuffer!=='undefined'&&bytes.buffer instanceof SharedArrayBuffer||bytes.length<32||bytes.length>(kind==='mask'?MASK_MAX:MAX))throw Error('Invalid workflow input size');
  // Count invalid attempts too, before parsing or storing bytes. This callback
  // must consume a genuine cumulative production preparation reservation.
  if(await reservePreparation({userId,bytes:bytes.length})!==true)throw Error('Workflow preparation limited');
  const inspection=await inspectWorkflowMp4(bytes,{role:kind==='mask'?'mask':'input'});
  if(inspection.geometryVerified!=='avc-sps'||inspection.presentationPts[0]!=='0/1'||inspection.durationSeconds<3||inspection.durationSeconds>15||inspection.width>1280||inspection.height>1280)throw Error('Choose a bounded exact working clip');
  if(kind==='mask'){
   if(!source||source.record.kind!=='source'||inspection.hasAudio||inspection.timelineSha256!==source.inspection.timelineSha256)throw Error('Mask does not match the owned source clock');
  }
  const now=time(),id=crypto.randomUUID(),record={version:'rig-workflow-input-v1',id,userId,kind,media:compact(inspection),source:source?{id:source.record.id,sha256:source.inspection.sha256}:null,createdAt:now,expiresAt:now+LIFETIME},storageKey=key(userId,id);
  const options={onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'video/mp4',cacheControl:'private, no-store'},customMetadata:{manifest:JSON.stringify(record)}};
  if(!await bucket.put(storageKey,bytes,options))throw Error('Workflow input storage uncertain');
  const saved=await bucket.head(storageKey);
  if(!saved||saved.size!==bytes.length||saved.customMetadata?.manifest!==options.customMetadata.manifest||saved.httpMetadata?.contentType!=='video/mp4'||saved.httpMetadata?.cacheControl!=='private, no-store')throw Error('Workflow input storage uncertain');
  return {id,sha256:inspection.sha256,kind,manifest:publicManifest(record),inspection};
 }
 return Object.freeze({
  get,
  putSource:({userId,bytes})=>put(userId,'source',bytes),
  async putMask({userId,sourceId,sourceSha256,bytes}){
   // A source is re-read from private owned storage; never from client metadata.
   await owner(userId);const source=await get({userId,id:sourceId,expectedSha256:sourceSha256});return put(userId,'mask',bytes,source);
  },
  async getPair({userId,sourceId,maskId}){
   const source=await get({userId,id:sourceId}),mask=await get({userId,id:maskId});
   if(source.record.kind!=='source'||mask.record.kind!=='mask'||mask.record.source.id!==sourceId||mask.record.source.sha256!==source.inspection.sha256||mask.inspection.timelineSha256!==source.inspection.timelineSha256)throw Error('Owned workflow pair does not match');
   return {source,mask};
  }
 });
}
