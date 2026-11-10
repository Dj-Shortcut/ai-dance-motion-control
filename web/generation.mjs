import {isProductionGenerationContext} from './production-generation-context.mjs';
import {providerJSON,providerInputValidation} from './provider-response.mjs';
import {isProviderInputUrl} from './rig-provider-inputs.mjs';
import {isR2InputUrl} from './rig-r2-inputs.mjs';
import {validateInlineInput,INLINE_REQUEST_MAX_BYTES} from './rig-inline-inputs.mjs';
import {RECAST_QUALITY,RECAST_MODEL,RECAST_QUEUE_FAMILY,RECAST_PROVIDER_CONTRACT,RECAST_SETTINGS,validRecastSettings,validRecastVideo} from './recast-contract.mjs';
// RIG generation module. External adapters must satisfy README contract.
// All prices are configured by the operator in integer eurocents; no defaults.
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const REQ_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const QUEUE = 'https://queue.fal.run';
const SUBJECT_REJECTED='Deze foto is niet geschikt voor persoonsbeweging. Kies Video bewerken, of gebruik een foto met een duidelijk zichtbaar menselijk bovenlichaam.';
const CAMERA_PROMPT = 'Single continuous wide full-body shot. The tripod camera remains stationary at a fixed distance and focal length throughout. Keep the person centered and their complete body visible from the top of the head to both shoes, with generous space above the head, below the feet and on both sides for all dance movements. Maintain the initial wide framing throughout the entire clip, with a stable background and realistic proportions. ';
// Ask for clean output in the existing generation, without a separate paid
// cleanup job. This does not modify source files or guarantee text removal.
const TEXT_CLEANUP_PROMPT = 'Remove all visible text, letters, captions, subtitles, app interfaces, logos and overlays. Restore the scene beneath, preserving the subject, movement, camera and audio. ';
const MODEL = Object.freeze({ standard: 'fal-ai/kling-video/v3/standard/motion-control', pro: 'fal-ai/kling-video/v3/pro/motion-control', 'edit-standard':'fal-ai/kling-video/o3/standard/video-to-video/edit',[RECAST_QUALITY]:RECAST_MODEL });
const O3_IDENTITY_CONTRACT='o3-identity-only-v1';
// This transfer changes who can read Fal's temporary copies. It is opt-in per
// quoted O3 edit, never inferred from the user, model default or runtime owner.
const TEMPORARY_FAL_LINKS='fal-temporary-links-v1';
const RESPONSE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const respond = (value, code=200) => Response.json(value,{status:code,headers:RESPONSE_HEADERS});
const fail = (message,code) => respond({error:message},code);
const rejectSubject = code => respond({error:SUBJECT_REJECTED,code:'subject_rejected',generationStarted:false},code);

export function isFalMedia(value) {
  try { const u = new URL(value); return u.protocol==='https:' && !u.username && !u.password && !u.port && !u.hash && u.hostname==='v3b.fal.media' && /^\/files\/b\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(u.pathname); } catch { return false; }
}
function validAsset(x, kind) { return !!x && x.verified===true && x.kind===kind && isFalMedia(x.url); }
function validTemporaryAsset(x,kind,ref) {
  if(!validAsset(x,kind)||x.inline===true||x.id!==ref.id||x.sha256!==ref.sha256||!Number.isSafeInteger(x.size)||x.size<=0)return false;
  try{const u=new URL(x.url);return u.href===u.origin+u.pathname;}catch{return false;}
}
function validPrepared(x,kind,id) { return !!x && x.verified===true && x.kind===kind && x.id===id && /^[a-f0-9]{64}$/.test(x.sha256??''); }
function configuredRate(s,quality) { return quality===RECAST_QUALITY?s.pricing.recast:quality==='edit-standard'?s.pricing.editStandard:s.pricing[quality]; }
function qualityEnabled(s,quality) { const rate=configuredRate(s,quality);return Number.isSafeInteger(rate)&&rate>0; }
function validEditVideo(video) { return video.durationVerified===true&&Number.isFinite(video.durationSeconds)&&video.durationSeconds>=3&&video.durationSeconds<=15&&Number.isSafeInteger(video.width)&&video.width>=720&&video.width<=3840&&Number.isSafeInteger(video.height)&&video.height>=720&&video.height<=3840&&Number.isFinite(video.fps)&&video.fps>=23&&video.fps<=60; }
const inlineFiveSeconds=duration=>Number.isFinite(duration)&&duration>=4.9&&duration<=5;
function editPrompt(prompt,hasIdentity=false) { return `Edit @Video1 using the subject shown in @Image1 as the replacement subject. Keep the original camera framing, camera movement and scene timing. ${hasIdentity?'Use @Element1 for the replacement subject identity and its appearance from different angles. ':''}${TEXT_CLEANUP_PROMPT}${prompt}`; }
function identityEditPrompt(prompt) { return `Edit @Video1 in place. Replace only the main subject's appearance with @Element1. @Video1 alone defines the scene, background, shot size, camera, body and facial motion, and timing. Keep its original audio. The identity photos define appearance only; never copy their room, pose or framing. ${TEXT_CLEANUP_PROMPT}${prompt}`; }
function generationPrompt(data){
 if(data.quality===RECAST_QUALITY)return data.prompt;
 if(data.quality==='edit-standard')return data.transferPolicy===TEMPORARY_FAL_LINKS?identityEditPrompt(data.prompt):editPrompt(data.prompt,Boolean(data.faceId));
 const prefix=(data.steadyCamera?CAMERA_PROMPT:'')+TEXT_CLEANUP_PROMPT+(data.faceId?'The replacement subject is @Element1. ':'');
 // Preserve the existing steady-camera user limit and keep the complete
 // provider prompt <=2500 UTF-16 units without splitting a surrogate pair.
 const selected=data.steadyCamera?Array.from(data.prompt).slice(0,1300).join(''):data.prompt;
 let userPrompt='';for(const character of selected){if(prefix.length+userPrompt.length+character.length>2500)break;userPrompt+=character;}
 return prefix+userPrompt;
}
function configured(s) {
  if (s?.mode !== 'test'&&!(s?.mode==='live'&&isProductionGenerationContext(s.productionContext,{origin:s.trustedOrigin}))) return false;
  try { if (new URL(s?.trustedOrigin).origin !== s.trustedOrigin || !s.trustedOrigin.startsWith('https://')) return false; } catch { return false; }
  return typeof s?.authenticate === 'function' && typeof s?.assets?.getOwned === 'function' && typeof s?.assets?.uploadOwned === 'function' && typeof s?.quotes?.create === 'function' && typeof s?.quotes?.getOwned === 'function' && typeof s?.jobs?.getByIdempotency === 'function' && typeof s?.jobs?.getRecent === 'function' && typeof s?.jobs?.begin === 'function' && typeof s?.jobs?.getOwned === 'function' && typeof s?.jobs?.authorizeDispatch === 'function' && typeof s?.jobs?.markSubmitted === 'function' && typeof s?.jobs?.markUnknown === 'function' && typeof s?.jobs?.markPreparationFailed === 'function' && typeof s?.jobs?.claimPoll === 'function' && typeof s?.jobs?.releasePoll === 'function' && typeof s?.jobs?.markCompleted === 'function' && typeof s?.jobs?.markProviderFailed === 'function' && typeof s?.results?.store === 'function' && typeof s?.results?.read === 'function' && typeof s?.falKey === 'string' && s.falKey.length>0 && s.falKey.length<1024 && Number.isSafeInteger(s?.pricing?.standard) && s.pricing.standard>0 && Number.isSafeInteger(s?.pricing?.pro) && s.pricing.pro>0 && typeof s.pricing.version==='string' && s.pricing.version.length>0;
}
function publicFunding(value) {
  if(value.fundingKind==='owner-provider'){
    const estimate=value.providerEstimateUsdMicros??value.input?.providerEstimateUsdMicros;
    if(!Number.isSafeInteger(estimate)||estimate<=0)throw Error('Invalid confirmed provider estimate');
    return {funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:estimate};
  }
  return {priceCents:value.priceCents,currency:'EUR'};
}
function failedPreparation(job,message){
  return {...publicJob(job),...(job.fundingKind==='owner-provider'?{finalizationConfirmed:true,message:`${message} Er is geen videogeneratie naar fal verstuurd.`}:{refundConfirmed:true,message:`${message} Je tegoed is teruggezet.`})};
}
function publicJob(job) {
  const failureCode=job.state==='failed'&&['provider_input_unavailable','provider_subject_not_detected'].includes(job.failureCode)?job.failureCode:null;
  return { id:job.id, state:job.state, ...publicFunding(job),...(failureCode?{failureCode}:{}) };
}
async function readJSON(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') ?? '')) return null;
  const declared=req.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared)>8192)) return null;
  if (!req.body) return null;
  const reader=req.body.getReader(), chunks=[]; let length=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if(done) break;
      length+=value.byteLength;
      if(length>8192) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes=new Uint8Array(length); let offset=0;
    for (const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch { try { await reader.cancel(); } catch {} return null; }
}

function inputData(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const { imageId, videoId, faceId=null, angleIds=[], quality, prompt='', keepSound=true, steadyCamera=!['edit-standard',RECAST_QUALITY].includes(quality), transferPolicy }=o;
  if (!ID.test(imageId??'') || !ID.test(videoId??'') || !Object.hasOwn(MODEL, quality) || typeof prompt!=='string' || prompt.length>1900 || typeof keepSound!=='boolean' || typeof steadyCamera!=='boolean' || !(faceId===null || ID.test(faceId)) || !Array.isArray(angleIds) || angleIds.length>3 || angleIds.some(x=>typeof x!=='string'||!ID.test(x)) || (angleIds.length>0 && !faceId)) return null;
  if (quality==='edit-standard' && (!prompt.trim() || steadyCamera)) return null;
  if(quality===RECAST_QUALITY&&(!prompt.trim()||faceId!==null||angleIds.length||steadyCamera||keepSound!==true||transferPolicy!==TEMPORARY_FAL_LINKS||['resolution','enhance_realism','enable_safety_checker'].some(key=>Object.hasOwn(o,key))))return null;
  // Extra edit identities use the current quote-bound temporary transfer.
  // Historical gateway/inline probes remain limited to their original pair.
  if (quality==='edit-standard' && faceId!==null && transferPolicy!==TEMPORARY_FAL_LINKS) return null;
  if(Object.hasOwn(o,'transferPolicy')&&(!['edit-standard',RECAST_QUALITY].includes(quality)||transferPolicy!==TEMPORARY_FAL_LINKS))return null;
  return {imageId,videoId,faceId,angleIds:[...angleIds],quality,prompt,keepSound,steadyCamera,...(transferPolicy?{transferPolicy}:{})};
}

// `create` and `begin` are deliberately contracts, not in-memory stand-ins.
// An isolated fail-closed router: no credentials, asset store, or durable ledger => 503.
export function createGenerationHandler(services, fetchImpl=fetch) {
  return async (req) => {
    if (!configured(services)) return fail('Genereren is nog niet beschikbaar.',503);
    let user; try {user=await services.authenticate(req);} catch {return fail('Aanmelden vereist.',401);}
    if (!user || typeof user.id!=='string' || !ID.test(user.id)) return fail('Aanmelden vereist.',401);
    const url=new URL(req.url), path=url.pathname;
    if(req.method==='POST' && (url.origin!==services.trustedOrigin || req.headers.get('origin')!==services.trustedOrigin)) return fail('Ongeldige oorsprong.',403);
    const intent=path.match(/^\/api\/generation-intents\/([A-Za-z0-9_-]{1,100})\/reconcile$/);
    if(req.method==='POST' && intent){
      if(typeof services.jobs.reconcileIntent!=='function')return fail('Opdrachtstatus is tijdelijk niet beschikbaar.',503);
      const data=await readJSON(req);if(!data||!ID.test(data.quoteId??''))return fail('Controleer je aanvraag.',400);
      try{const result=await services.jobs.reconcileIntent(user.id,intent[1],data.quoteId);
        if(result?.kind==='canceled')return respond({state:'canceled'});
        if(result?.kind==='existing'&&result.job?.userId===user.id&&result.job.quoteId===data.quoteId)return respond(publicJob(result.job));
        return fail('Deze aanvraagcode is al gebruikt.',409);
      }catch{return fail('Opdrachtstatus is tijdelijk niet beschikbaar.',503);}
    }
    if(req.method==='GET' && path==='/api/generations/recent') {
      try {const job=await services.jobs.getRecent(user.id);if(!job)return respond({job:null});if(job.userId!==user.id)return fail('Opdracht niet gevonden.',404);return respond({job:{...publicJob(job),...(job.state==='completed'?{videoPath:`/api/generations/${job.id}/video`}:{})}});} catch{return fail('Status is tijdelijk niet beschikbaar.',503);}
    }
    if (req.method==='POST' && path==='/api/generation-quotes') {
      const raw=await readJSON(req);
      if(raw?.quality==='edit-standard'&&Array.isArray(raw.angleIds)&&raw.angleIds.length>2)return fail('Gebruik voor videobewerking maximaal vier foto’s: een hoofdbeeld, een close-up en twee hoeken.',400);
      const data=inputData(raw); if (!data) return fail('Controleer je invoer.',400);
      if (!qualityEnabled(services,data.quality)) return fail('Dit videomodel is nog niet beschikbaar.',503);
      if(services.mode==='live'&&data.quality==='edit-standard'&&data.transferPolicy!==TEMPORARY_FAL_LINKS)return fail('Bevestig de tijdelijke Fal-bestandslinks voor deze videobewerking.',400);
      const prompt=generationPrompt(data);if(prompt.length>2500)return fail('Houd je beschrijving korter.',400);
      // The verified media service limits concurrent work. Resolve assets one at
      // a time so one user's photo/video cannot exhaust that limit itself.
      let assets; try {assets=[];for(const id of [data.imageId,data.videoId,...(data.faceId?[data.faceId]:[]),...data.angleIds])assets.push(await services.assets.getOwned(user.id,id));} catch {return fail('Bestanden zijn tijdelijk niet beschikbaar.',503);}
      const [image,video,...rest]=assets;
      const ids=[data.imageId,data.videoId,...(data.faceId?[data.faceId]:[]),...data.angleIds];
      if (!validPrepared(image,'image',ids[0]) || !validPrepared(video,'video',ids[1]) || rest.some((x,i)=>!validPrepared(x,'image',ids[i+2]))) return fail('Kies geldige voorbereide bestanden.',400);
      if(['standard','pro'].includes(data.quality)){
        try{if(typeof services.jobs.hasKnownSubjectRejection!=='function')throw Error('Subject check unavailable');if(await services.jobs.hasKnownSubjectRejection(user.id,image.sha256))return rejectSubject(400)}catch{return fail('De fotocontrole is tijdelijk niet beschikbaar.',503)}
      }
      // durationSeconds MUST be obtained by an independent trusted server verifier,
      // not from a browser, file name or untrusted user-provided metadata.
      if (video.durationVerified!==true || !Number.isFinite(video.durationSeconds) || video.durationSeconds<3 || video.durationSeconds>30) return fail('De videoduur kon niet veilig worden vastgesteld.',400);
      if (data.quality==='edit-standard' && !validEditVideo(video)) return fail('Kies voor deze videobewerking 3 tot 15 seconden, minstens 720 pixels breed en hoog, met 23 tot 60 beelden per seconde.',400);
      if(data.quality===RECAST_QUALITY&&!validRecastVideo(video))return fail('Kies voor personen vervangen een voorbereid fragment van minstens 5 en maximaal 15 echte seconden. Bereid je video opnieuw voor; een fragment van 4,92 seconden is te kort.',400);
      if (data.quality==='edit-standard' && data.transferPolicy!==TEMPORARY_FAL_LINKS && services.inlineO3Owner===user.id && !inlineFiveSeconds(video.durationSeconds)) return fail('Kies voor deze privéproef een fragment van 5 seconden.',400);
      let cents,providerEstimateUsdMicros=null;
      try{
        if(services.mode==='live'){
          providerEstimateUsdMicros=await services.trialGuard.estimate(data.quality,video.durationSeconds);
          cents=await services.trialGuard.retailPrice(data.quality,video.durationSeconds,providerEstimateUsdMicros);
        }else cents=Math.ceil(video.durationSeconds)*configuredRate(services,data.quality);
      }catch{return fail('Prijs is tijdelijk niet beschikbaar.',503)}
      if (!Number.isSafeInteger(cents) || cents<=0) return fail('Prijs is niet beschikbaar.',503);
      if(services.trialGuard && !await services.trialGuard.permits({durationSeconds:video.durationSeconds,priceCents:cents}))return fail(services.trialGuard.limitMessage||'Deze video past niet binnen het beschikbare testbudget.',400);
      if(services.mode!=='live'&&services.trialGuard){try{providerEstimateUsdMicros=await services.trialGuard.estimate(data.quality,video.durationSeconds)}catch{return fail('De actuele fal-prijs is niet beschikbaar of valt buiten de testlimiet.',503)}}
      // Store only owned asset identifiers and hashes; sending bytes to fal is
      // deferred until the customer confirms the quote and funds are reserved.
      const input={data,refs:assets.map((asset,i)=>({id:ids[i],kind:asset.kind,sha256:asset.sha256})),prompt,...(data.quality==='edit-standard'&&data.transferPolicy===TEMPORARY_FAL_LINKS?{providerContract:O3_IDENTITY_CONTRACT}:{}),...(data.quality===RECAST_QUALITY?{providerContract:RECAST_PROVIDER_CONTRACT,providerSettings:{...RECAST_SETTINGS}}:{}),...(providerEstimateUsdMicros!==null?{providerEstimateUsdMicros}:{})};
      let quote; try {quote=await services.quotes.create({userId:user.id,model:MODEL[data.quality],input,priceCents:cents,pricingVersion:services.pricing.version,durationSeconds:video.durationSeconds});} catch {return fail('Prijsopgave is tijdelijk niet beschikbaar.',503);}
      if (!quote || !ID.test(quote.id??'') || !Number.isFinite(quote.expiresAt) || quote.expiresAt<=Date.now()) return fail('Prijsopgave is tijdelijk niet beschikbaar.',503);
      return respond({id:quote.id,quality:data.quality,durationSeconds:video.durationSeconds,billedSeconds:Math.ceil(video.durationSeconds),...publicFunding({...quote,priceCents:cents,providerEstimateUsdMicros}),expiresAt:quote.expiresAt,...(data.transferPolicy?{transferPolicy:data.transferPolicy,transferConsentRequired:true}:{}),...(providerEstimateUsdMicros!==null&&!(services.mode==='live'&&quote.fundingKind==='credits')?{providerEstimateUsdMicros}:{})},201);
    }
    if (req.method==='POST' && path==='/api/generations') {
      const data=await readJSON(req);
      if (!data || !ID.test(data.quoteId??'') || !ID.test(data.idempotencyKey??'')) return fail('Controleer je aanvraag.',400);
      // Recover a previously accepted submission even after its quote expires.
      let prior; try {prior=await services.jobs.getByIdempotency(user.id,data.idempotencyKey);} catch {return fail('Aanvraagstatus is tijdelijk niet beschikbaar.',503);}
      if(prior){if(prior.userId!==user.id || prior.quoteId!==data.quoteId)return fail('Deze aanvraagcode is al gebruikt.',409);return respond(publicJob(prior));}
      let quote; try {quote=await services.quotes.getOwned(user.id,data.quoteId);} catch {return fail('Prijsopgave is tijdelijk niet beschikbaar.',503);}
      // Existing jobs remain recoverable above. An unstarted edit must obtain
      // a fresh quote for the changed identity-only provider contract.
      if(quote?.userId===user.id&&quote.model===MODEL['edit-standard']&&quote.input?.data?.transferPolicy===TEMPORARY_FAL_LINKS&&(quote.input.providerContract!==O3_IDENTITY_CONTRACT||Array.isArray(quote.input.data.angleIds)&&quote.input.data.angleIds.length>2))return fail('Vraag opnieuw de prijs op om deze videobewerking te bevestigen.',409);
      if(quote?.userId===user.id&&quote.model===RECAST_MODEL&&(quote.input?.providerContract!==RECAST_PROVIDER_CONTRACT||!validRecastSettings(quote.input?.providerSettings)||quote.input?.prompt!==quote.input?.data?.prompt||quote.input?.refs?.length!==2))return fail('Vraag opnieuw de prijs op om deze personenvervanging te bevestigen.',409);
      if (!quote || quote.userId!==user.id || !Object.values(MODEL).includes(quote.model) || !Number.isSafeInteger(quote.priceCents) || quote.priceCents<=0 || !Number.isFinite(quote.expiresAt) || quote.expiresAt<=Date.now() || !quote.input || !inputData(quote.input.data) || !Array.isArray(quote.input.refs) || quote.input.refs.length<2 || quote.input.refs.length>6) return fail('Prijsopgave is niet geldig of verlopen.',409);
      if (quote.model!==MODEL[quote.input.data.quality] || !qualityEnabled(services,quote.input.data.quality)) return fail('Dit videomodel is niet beschikbaar. Vraag opnieuw de prijs op.',409);
      if(services.mode==='live'&&quote.input.data.quality==='edit-standard'&&quote.input.data.transferPolicy!==TEMPORARY_FAL_LINKS)return fail('Bevestig de tijdelijke Fal-bestandslinks voor deze videobewerking.',409);
      const temporaryLinks=[MODEL['edit-standard'],RECAST_MODEL].includes(quote.model)&&quote.input.data.transferPolicy===TEMPORARY_FAL_LINKS;
      // Consent authorizes this quote only. Reject before credit reservation,
      // media export or provider work, while preserving prior-job recovery.
      if(Object.hasOwn(data,'transferPolicy')||(temporaryLinks?data.transferConsent!==TEMPORARY_FAL_LINKS:Object.hasOwn(data,'transferConsent')))return fail('Bevestig opnieuw de prijs en de tijdelijke Fal-bestandslinks.',400);
      const inlineEdit=!temporaryLinks&&quote.model===MODEL['edit-standard']&&services.inlineO3Owner===user.id;
      if(inlineEdit&&!inlineFiveSeconds(quote.durationSeconds))return fail('Kies voor deze privéproef 5 seconden en vraag de prijs opnieuw op.',409);
      if(services.mode==='live'){
        try{if(!await services.trialGuard.quoteCurrent(quote))return fail('Vraag de prijs opnieuw op en bevestig die opnieuw.',409);}catch{return fail('De prijs kon tijdelijk niet worden gecontroleerd.',503)}
      }
      if(services.trialGuard && !await services.trialGuard.permits({durationSeconds:quote.durationSeconds,priceCents:quote.priceCents,quote}))return fail(services.trialGuard.limitMessage||'Deze prijs past niet binnen het beschikbare testbudget.',409);
      if(['standard','pro'].includes(quote.input.data.quality)){
        const imageRef=quote.input.refs[0];
        if(!imageRef||imageRef.kind!=='image'||imageRef.id!==quote.input.data.imageId||!/^[a-f0-9]{64}$/.test(imageRef.sha256??''))return fail('Prijsopgave is niet geldig of verlopen.',409);
        try{if(typeof services.jobs.hasKnownSubjectRejection!=='function')throw Error('Subject check unavailable');if(await services.jobs.hasKnownSubjectRejection(user.id,imageRef.sha256))return rejectSubject(409)}catch{return fail('De fotocontrole is tijdelijk niet beschikbaar.',503)}
      }
      const authorizationError=quote.fundingKind==='owner-provider'?'Je fal-opdracht kon niet veilig worden vastgelegd.':'Tegoed kon niet worden gereserveerd.';
      let started; try {started=await services.jobs.begin({userId:user.id,quoteId:data.quoteId,idempotencyKey:data.idempotencyKey,quote,verification:data.verification,verificationPayload:{quoteId:data.quoteId,idempotencyKey:data.idempotencyKey,...(Object.hasOwn(data,'transferConsent')?{transferConsent:data.transferConsent}:{})}});} catch {return fail(authorizationError,503);}
      if(started?.kind==='verification'&&started.response instanceof Response)return started.response;
      if (!started || !['created','existing','conflict','insufficient','pending','subject_rejected','pricing'].includes(started.kind)) return fail(authorizationError,503);
      if (started.kind==='pricing') return fail('Vraag de prijs opnieuw op en bevestig die opnieuw.',409);
      if (started.kind==='subject_rejected') return rejectSubject(409);
      if (started.kind==='conflict') return fail('Deze aanvraagcode of prijsopgave is al gebruikt.',409);
      if (started.kind==='insufficient') return fail(quote.fundingKind==='owner-provider'?'Je fal-opdracht is niet beschikbaar of je account wordt gecontroleerd.':'Onvoldoende tegoed.',402);
      if (started.kind==='pending') return fail('Een eerdere opdracht is nog niet afgerond. Controleer eerst de status.',409);
      if (!started.job || !ID.test(started.job.id??'')) return fail('Aanvraagstatus is onzeker.',503);
      if (started.kind==='existing') return respond(publicJob(started.job));
      const jobId=started.job.id;
      const acceptedJob={...started.job,priceCents:quote.priceCents,fundingKind:quote.fundingKind,providerEstimateUsdMicros:quote.input.providerEstimateUsdMicros};
      let providerInput,providerBody,preparationFailure='Bestanden konden niet worden voorbereid.';
      try {
        if(services.trialGuard){if(services.mode==='live')preparationFailure='De prijs moet opnieuw worden gecontroleerd. Vraag een nieuwe prijsopgave.';const estimate=quote.input.providerEstimateUsdMicros;if(!Number.isSafeInteger(estimate)||estimate<=0)throw Error('Missing confirmed provider estimate');const current=await services.trialGuard.estimate(quote.input.data.quality,quote.durationSeconds);if(current>estimate)throw Error('Provider price increased');preparationFailure='Bestanden konden niet worden voorbereid.';}
        if(services.trialGuard && !await services.trialGuard.claimOnce({userId:user.id,jobId,quote}))throw Error('Trial allowance unavailable');
        // Quotes bind immutable content hashes, so replacing an owned asset
        // after pricing cannot alter the bytes sent to fal.
        const selected=inputData(quote.input.data), refs=quote.input.refs;
        const ids=[selected.imageId,selected.videoId,...(selected.faceId?[selected.faceId]:[]),...selected.angleIds];
        if(refs.length!==ids.length || typeof quote.input.prompt!=='string' || quote.input.prompt.length>2500)throw Error('invalid quote');
        if(selected.quality==='edit-standard'){
          const verified=await services.assets.getOwned(user.id,selected.videoId);
          if(!validPrepared(verified,'video',selected.videoId)||verified.sha256!==refs[1]?.sha256||!validEditVideo(verified)||inlineEdit&&!inlineFiveSeconds(verified.durationSeconds))throw Error('Invalid prepared edit video');
        }
        if(selected.quality===RECAST_QUALITY){
          const verified=await services.assets.getOwned(user.id,selected.videoId);
          if(!validPrepared(verified,'video',selected.videoId)||verified.sha256!==refs[1]?.sha256||!validRecastVideo(verified))throw Error('Invalid prepared recast video');
        }
        const uploaded=[];
        for(let i=0;i<refs.length;i++){
          const kind=i===1?'video':'image', ref=refs[i];
          if(!ref||ref.id!==ids[i]||ref.kind!==kind||!/^[a-f0-9]{64}$/.test(ref.sha256??''))throw Error('invalid reference');
          const asset=await services.assets.uploadOwned(user.id,ref.id,ref.sha256,['edit-standard',RECAST_QUALITY].includes(selected.quality)?{jobId,model:quote.model,...(temporaryLinks?{transferPolicy:TEMPORARY_FAL_LINKS}:{})}:undefined);
          if(temporaryLinks){
            if(!validTemporaryAsset(asset,kind,ref))throw Error('Invalid temporary Fal input');
          }else if(inlineEdit){
            if(asset?.id!==ref.id||asset.sha256!==ref.sha256||!await validateInlineInput(asset,{kind,sha256:ref.sha256}))throw Error('Invalid inline input');
          }else if(asset?.inline===true|| (selected.quality==='edit-standard' ? !(asset?.verified===true&&asset.kind===kind&&(services.inputR2Config?isR2InputUrl(asset.url,{config:services.inputR2Config,kind}):isProviderInputUrl(asset.url,services.inputGatewayOrigin,kind))) : !validAsset(asset,kind)))throw Error('invalid uploaded asset');
          uploaded.push(asset);
        }
        const [image,video,...rest]=uploaded;
        if(selected.quality===RECAST_QUALITY){
          if(!temporaryLinks||quote.input.providerContract!==RECAST_PROVIDER_CONTRACT||!validRecastSettings(quote.input.providerSettings)||quote.input.prompt!==selected.prompt||!validRecastVideo(video)||rest.length)throw Error('Invalid recast input');
          providerInput={video_url:video.url,reference_image_urls:[image.url],prompt:quote.input.prompt,...RECAST_SETTINGS};
        }else if(selected.quality==='edit-standard'){
          if(!validEditVideo(video)||!quote.input.prompt.includes('@Video1'))throw Error('Invalid edit input');
          if(temporaryLinks){
            if(quote.input.providerContract!==O3_IDENTITY_CONTRACT||!quote.input.prompt.includes('@Element1'))throw Error('Invalid edit identity');
            // All selected photos condition one identity element. No image_urls
            // field may condition the scene: the video is the sole base footage.
            // With a close-up, main + at most two angles fit its three references.
            const identity={frontal_image_url:selected.faceId?rest[0].url:image.url,reference_image_urls:[image.url,...(selected.faceId?rest.slice(1).map(x=>x.url):[])]};
            providerInput={video_url:video.url,elements:[identity],prompt:quote.input.prompt,keep_audio:selected.keepSound,enable_safety_checker:true,shot_type:'customize'};
          }else{
            // Historical private gateway/inline probes retain their original
            // two-input contract and never receive the new scene-role mapping.
            if(!quote.input.prompt.includes('@Image1'))throw Error('Invalid edit input');
            providerInput={video_url:video.url,image_urls:[image.url],prompt:quote.input.prompt,keep_audio:selected.keepSound,enable_safety_checker:true};
          }
        }else{
          providerInput={image_url:image.url,video_url:video.url,character_orientation:'video',prompt:quote.input.prompt,keep_original_sound:selected.keepSound,enable_safety_checker:true};
          if(selected.faceId){providerInput.elements=[{frontal_image_url:rest[0].url,reference_image_urls:selected.angleIds.length?rest.slice(1).map(x=>x.url):[image.url]}];if(!providerInput.prompt.includes('@Element1'))providerInput.prompt+=' The person is @Element1.';}
        }
        // Inline bytes stay only in this authenticated server-to-provider body.
        // Bound the complete encoding before the atomic dispatch decision; no
        // fallback upload, public link or paid retry is permitted on overflow.
        providerBody=JSON.stringify(providerInput);
        if(inlineEdit&&new TextEncoder().encode(providerBody).byteLength>INLINE_REQUEST_MAX_BYTES)throw Error('Inline request too large');
        // Uploads may take time. Recheck the selected model immediately before
        // the atomic dispatch decision without changing the confirmed price.
        if(services.mode==='live'){
          preparationFailure='De prijs moet opnieuw worden gecontroleerd. Vraag een nieuwe prijsopgave.';
          const current=await services.trialGuard.estimate(quote.input.data.quality,quote.durationSeconds);
          if(current>quote.input.providerEstimateUsdMicros)throw Error('Provider price increased during preparation');
        }
      } catch {
        // No generation request has been sent yet. Release once, transactionally.
        try {
          const failed=await services.jobs.markPreparationFailed(user.id,jobId);
          return respond(failedPreparation(failed,preparationFailure));
        } catch {
          try {await services.jobs.markUnknown(user.id,jobId);} catch {}
          return respond({...publicJob(acceptedJob),state:'unknown',message:quote.fundingKind==='owner-provider'?'Je fal-opdracht wordt gecontroleerd. Start niet opnieuw.':'Het tegoed wordt gecontroleerd.'},202);
        }
      }
      // Serialize the one dispatch decision with account freezes. A lost DB
      // response is ambiguous: never submit or automatically release it.
      let authorized;
      try {authorized=await services.jobs.authorizeDispatch(user.id,jobId);} catch {
        try {await services.jobs.markUnknown(user.id,jobId);} catch {}
        return respond({...publicJob(acceptedJob),state:'unknown',message:'De opdracht wordt gecontroleerd.'},202);
      }
      if(authorized!==true){
        try {const failed=await services.jobs.markPreparationFailed(user.id,jobId);return respond(failedPreparation(failed,'De opdracht kon niet worden gestart.'));}
        catch {try {await services.jobs.markUnknown(user.id,jobId);} catch {}return respond({...publicJob(acceptedJob),state:'unknown',message:'De opdracht wordt gecontroleerd.'},202);}
      }
      try {
        const signal=AbortSignal.timeout(30000);
        const lifecycle=temporaryLinks?{expiration_duration_seconds:86400}:{expiration_duration_seconds:86400,initial_acl:{default:'forbid',rules:[]}};
        const r=await fetchImpl(`${QUEUE}/${quote.model}`,{method:'POST',redirect:'manual',signal,headers:{Authorization:`Key ${services.falKey}`,'Content-Type':'application/json','X-Fal-No-Retry':'1','X-Fal-Request-Start-Timeout':'300','x-app-fal-disable-fallback':'true','X-Fal-Store-IO':'0','X-Fal-Object-Lifecycle-Preference':JSON.stringify(lifecycle)},body:providerBody});
        if (!r.ok) throw Error('ambiguous');
        const result=await providerJSON(r,{signal}); if (!REQ_ID.test(result.request_id??'')) throw Error('ambiguous');
        await services.jobs.markSubmitted(user.id,jobId,result.request_id);
        return respond({...publicJob(acceptedJob),state:'queued'},202);
      } catch {
        try {await services.jobs.markUnknown(user.id,jobId);} catch {}
        return respond({...publicJob(acceptedJob),state:'unknown',message:'De inzending wordt gecontroleerd. Start niet opnieuw.'},202);
      }
    }
    async function publicFailure(job) {
      if(job.state!=='failed')return publicJob(job);
      const inputFailure=['provider_input_unavailable','provider_subject_not_detected'].includes(job.failureCode);
      if(inputFailure&&!REQ_ID.test(job.falRequestId??''))return publicJob(job);
      const owner=job.fundingKind==='owner-provider';
      const confirm=owner?services.jobs.confirmFailureFinalized:inputFailure?services.jobs.confirmInputFailureRefund:services.jobs.confirmFailureRefund;
      if(typeof confirm!=='function')return publicJob(job);
      try {return {...publicJob(job),...(await confirm.call(services.jobs,user.id,job.id,job.falRequestId??null)===true?(owner?{finalizationConfirmed:true}:{refundConfirmed:true}):{})};}catch{return publicJob(job);}
    }
    const match=path.match(/^\/api\/generations\/([a-zA-Z0-9_-]{1,100})(\/video)?$/);
    if(req.method==='GET' && match) {
      let job; try {job=await services.jobs.getOwned(user.id,match[1]);} catch {return fail('Status is tijdelijk niet beschikbaar.',503);}
      if(!job || job.userId!==user.id) return fail('Opdracht niet gevonden.',404);
      if(match[2]) { if(job.state!=='completed') return fail('Video is nog niet beschikbaar.',404); try {return await services.results.read(job);} catch {return fail('Video is tijdelijk niet beschikbaar.',503);} }
      if(job.state==='completed') return respond({...publicJob(job),videoPath:`/api/generations/${job.id}/video`});
      if(job.state!=='queued' || !REQ_ID.test(job.falRequestId??'')) return respond(await publicFailure(job));
      let allowInlineEcho=false,resultTransferPolicy,requestFamily;
      try{
        const q=await services.quotes.getOwned(user.id,job.quoteId);
        if(!q||q.userId!==user.id||q.id!==job.quoteId||!Object.values(MODEL).includes(q.model)||!inputData(q.input?.data))return fail('Status is tijdelijk niet beschikbaar.',503);
        requestFamily=q.model===RECAST_MODEL?RECAST_QUEUE_FAMILY:'fal-ai/kling-video';
        if([MODEL['edit-standard'],RECAST_MODEL].includes(q.model)&&MODEL[q.input.data.quality]===q.model&&q.input.data.transferPolicy===TEMPORARY_FAL_LINKS)resultTransferPolicy=TEMPORARY_FAL_LINKS;
        allowInlineEcho=resultTransferPolicy===undefined&&services.inlineO3Owner===user.id&&q.model===MODEL['edit-standard']&&inlineFiveSeconds(q.durationSeconds);
      }catch{return fail('Status is tijdelijk niet beschikbaar.',503);}
      const url=`${QUEUE}/${requestFamily}/requests/${encodeURIComponent(job.falRequestId)}`;
      let claim; try {claim=await services.jobs.claimPoll(user.id,job.id);} catch {return fail('Status is tijdelijk niet beschikbaar.',503);}
      if(!claim || claim.kind!=='acquired' || !REQ_ID.test(claim.token??'')) {
        // Re-read: another poll may have completed just before the claim.
        try {const latest=await services.jobs.getOwned(user.id,job.id);if(!latest || latest.userId!==user.id)return fail('Opdracht niet gevonden.',404);if(latest.state==='completed')return respond({...publicJob(latest),videoPath:`/api/generations/${latest.id}/video`});if(latest.state!=='queued')return respond(await publicFailure(latest));} catch {return fail('Status is tijdelijk niet beschikbaar.',503);}
        return respond({...publicJob(job),state:'processing'});
      }
      const signal=AbortSignal.timeout(60_000);
      try {
        const status=await fetchImpl(`${url}/status`,{signal,redirect:'manual',headers:{Authorization:`Key ${services.falKey}`}}); if(!status.ok) throw Error();
        const s=await providerJSON(status,{signal}); if(s.request_id!==job.falRequestId || !['IN_QUEUE','IN_PROGRESS','COMPLETED'].includes(s.status)) throw Error();
        if(s.status!=='COMPLETED') return respond({...publicJob(job),state:s.status==='IN_QUEUE'?'queued':'processing'});
        if(s.error || s.error_type) {
          // Refund only after an explicit, authenticated terminal provider failure.
          // Network errors, missing results and unrecognised errors remain queued.
          if(typeof s.error!=='string' || !s.error.trim()) return respond({...publicJob(job),state:'needs_review'});
          const failed=await services.jobs.markProviderFailed(user.id,job.id,job.falRequestId,claim.token);
          return respond(await publicFailure(failed));
        }
        const response=await fetchImpl(url,{signal,redirect:'manual',headers:{Authorization:`Key ${services.falKey}`}});
        if(!response.ok){
          const reason=await providerInputValidation(response,{signal,requestId:job.falRequestId,allowInlineEcho});
          if(reason){
            if(reason==='provider_subject_not_detected'){
              const q=await services.quotes.getOwned(user.id,job.quoteId);
              if(!q || q.userId!==user.id || q.model!==MODEL.pro)throw Error('Unrecognized model failure');
            }
            const failed=await services.jobs.markProviderFailed(user.id,job.id,job.falRequestId,claim.token,reason);
            return respond(await publicFailure(failed));
          }
          throw Error();
        }
        const result=await providerJSON(response,{signal}); if(!isFalMedia(result?.video?.url)) throw Error();
        const key=await services.results.store(job,result.video.url,{signal,...(resultTransferPolicy?{transferPolicy:resultTransferPolicy}:{})});
        const completed=await services.jobs.markCompleted(user.id,job.id,job.falRequestId,key,claim.token);
        return respond({...publicJob(completed),videoPath:`/api/generations/${job.id}/video`});
      } catch {return fail('Status is tijdelijk niet beschikbaar.',503);}
      finally {try {await services.jobs.releasePoll(user.id,job.id,claim.token);} catch {/* lease expiry permits recovery */}}
    }
    return fail('Niet gevonden.',404);
  };
}
