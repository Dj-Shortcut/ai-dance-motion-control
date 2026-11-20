// Customer passkeys authorize one exact credit-funded video. These credentials
// are deliberately separate from owner security and confer no owner authority.
import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
import {RECAST_MODEL} from './recast-contract.mjs';
import {passkeyOrigin} from './native-passkey.mjs';

export const CUSTOMER_RP_ID='rig-motion-studio.shortcutcomputerguy.chatgpt.site';
export const CUSTOMER_ORIGIN='https://'+CUSTOMER_RP_ID;
const SITE='appgprj_6aeec13b50448191b88da670dac8aa98';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const B64=/^[A-Za-z0-9_-]{1,2048}$/;
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const fail=(code,message,status=428)=>({ok:false,response:json({error:message,code},status)});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const base64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const unbase64=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),x=>x.charCodeAt(0));
export const customerSecurityHash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
const identitySQL=user=>`EXISTS(SELECT 1 FROM rig_sites_identities WHERE site_id='${SITE}' AND user_id=${user})`;
const active=(db,userId)=>db.prepare("SELECT * FROM rig_customer_credentials WHERE user_id=? AND state='active'").bind(userId).first();
const enrolled=(db,userId)=>db.prepare('SELECT 1 AS found FROM rig_customer_credentials WHERE user_id=?').bind(userId).first();
const publicCredential=k=>({id:k.credential_id,label:k.label,createdAt:k.created_at,activatedAt:k.activated_at});

function canonicalPayload(payload){
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!UUID.test(payload.quoteId||'')||!ID.test(payload.idempotencyKey||'')||Object.keys(payload).some(k=>!['quoteId','idempotencyKey','transferConsent'].includes(k))||Object.hasOwn(payload,'transferConsent')&&payload.transferConsent!=='fal-temporary-links-v1')throw Error('Invalid generation payload');
 return {quoteId:payload.quoteId,idempotencyKey:payload.idempotencyKey,...(Object.hasOwn(payload,'transferConsent')?{transferConsent:payload.transferConsent}:{})};
}
const quoteMatch=(c,q)=>`${q}.id=${c}.quote_id AND ${q}.user_id=${c}.user_id AND ${q}.funding_kind='credits'
 AND ${q}.model=${c}.quote_model AND ${q}.input_json=${c}.quote_input_json AND ${q}.price_cents=${c}.quote_price_cents
 AND ${q}.pricing_version=${c}.quote_pricing_version AND ${q}.duration_seconds=${c}.quote_duration_seconds AND ${q}.expires_at=${c}.quote_expires_at`;
async function generationOperation(db,userId,payload,now){
 const value=canonicalPayload(payload);
 const q=await db.prepare(`SELECT q.* FROM rig_generation_quotes q WHERE q.id=? AND q.user_id=? AND q.funding_kind='credits' AND q.expires_at>? AND ${identitySQL('q.user_id')}`).bind(value.quoteId,userId,now).first();
 if(!q||!Number.isSafeInteger(q.price_cents)||q.price_cents<=0||!Number.isFinite(q.duration_seconds)||q.duration_seconds<3||q.duration_seconds>30)throw Error('Quote unavailable');
 const input=JSON.parse(q.input_json),temporary=['fal-ai/kling-video/o3/standard/video-to-video/edit',RECAST_MODEL].includes(q.model)&&input?.data?.transferPolicy==='fal-temporary-links-v1';
 if(temporary?!Object.hasOwn(value,'transferConsent'):Object.hasOwn(value,'transferConsent'))throw Error('Transfer consent changed');
 const snapshot={id:q.id,userId:q.user_id,model:q.model,inputJson:q.input_json,priceCents:q.price_cents,pricingVersion:q.pricing_version,durationSeconds:q.duration_seconds,fundingKind:q.funding_kind,expiresAt:q.expires_at};
 const payloadJson=JSON.stringify(value),digest=await customerSecurityHash('customer-generation\0'+JSON.stringify({payload:value,quote:snapshot}));
 return {value,payloadJson,digest,q};
}
// Exported for verification fixtures and diagnostics. No mutation or spending.
export async function customerGenerationDigest(db,{userId,payload,now=Date.now()}={}){return (await generationOperation(db,userId,payload,now)).digest;}
function validClientData(credential,type,expectedOrigin=CUSTOMER_ORIGIN){
 if(!credential||typeof credential!=='object'||Array.isArray(credential)||credential.type!=='public-key'||!B64.test(credential.id||'')||credential.rawId!==credential.id||!B64.test(credential.response?.clientDataJSON||''))return false;
 try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unbase64(credential.response.clientDataJSON)));return data.type===type&&data.origin===expectedOrigin&&(data.crossOrigin===false||expectedOrigin?.startsWith('android:apk-key-hash:')&&data.crossOrigin===undefined)&&!Object.hasOwn(data,'topOrigin');}catch{return false;}
}
async function readJSON(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;let size=0;const parts=[];
 try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8192)return null;parts.push(r.value);}const out=new Uint8Array(size);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(out));return data&&typeof data==='object'&&!Array.isArray(data)?data:null;}catch{return null;}finally{void reader.cancel().catch(()=>{});}
}
async function rejectAssertion(db,c,now){
 await db.prepare('UPDATE rig_customer_security_challenges SET attempted_at=? WHERE id=? AND user_id=? AND used_at IS NULL AND attempted_at IS NULL').bind(now,c.id,c.user_id).run();
 return fail('verification_invalid','De passkey kon niet worden gecontroleerd. Vraag een nieuwe bevestiging.');
}

// Caller supplies the authenticated production Sites UUID. Every debit and job
// insert MUST include gate.sql/params in the SAME D1 batch as before. This
// helper verifies the assertion only; it never reserves money or starts work.
export async function prepareCustomerGeneration(db,{userId,payload,verification,securityEnv,now=Date.now()}={}){
 const expectedOrigin=passkeyOrigin(securityEnv,CUSTOMER_ORIGIN);
 if(!expectedOrigin)return fail('native_security_not_configured','Apparaatbevestiging is nog niet ingesteld voor deze app.',503);
 if(!USER.test(userId||'')||!Number.isSafeInteger(now)||now<0)return fail('verification_invalid','Bevestiging is niet beschikbaar.');
 let operation;try{operation=await generationOperation(db,userId,payload,now);}catch{return fail('operation_changed','Deze prijsopgave is gewijzigd of verlopen. Vraag opnieuw de prijs op.',409);}
 const key=await active(db,userId);if(!key)return fail('security_setup_required','Stel eerst je passkey in om een video te maken.');
 if(!exact(verification,['challengeId','credential'])||!UUID.test(verification.challengeId||''))return fail('step_up_required','Bevestig deze video met je passkey.');
 const c=await db.prepare("SELECT * FROM rig_customer_security_challenges WHERE id=? AND user_id=? AND operation='customer-generation'").bind(verification.challengeId,userId).first();
 if(!c||c.payload_hash!==operation.digest||c.payload_json!==operation.payloadJson||c.used_at!==null||c.attempted_at!==null)return fail('verification_invalid','Deze bevestiging is niet geldig. Vraag een nieuwe bevestiging.');
 if(c.expires_at<=now)return fail('verification_expired','De bevestiging is verlopen. Probeer opnieuw.');
 if(key.credential_id!==verification.credential?.id||!validClientData(verification.credential,'webauthn.get',expectedOrigin))return rejectAssertion(db,c,now);
 let proof;
 try{
  const handle=verification.credential.response?.userHandle;if(handle!==null&&handle!==undefined&&handle!==key.user_handle)throw Error('Wrong user handle');
  proof=await verifyAuthenticationResponse({response:verification.credential,expectedChallenge:c.challenge,expectedOrigin,expectedRPID:CUSTOMER_RP_ID,requireUserVerification:true,credential:{id:key.credential_id,publicKey:unbase64(key.public_key),counter:key.counter,transports:JSON.parse(key.transports_json)}});
  if(!proof.verified||proof.authenticationInfo.userVerified!==true)throw Error('User verification required');
 }catch{return rejectAssertion(db,c,now);}
 const counter=proof.authenticationInfo.newCounter;if(!Number.isSafeInteger(counter)||counter<0)return fail('verification_invalid','De passkey kon niet worden gecontroleerd.');
 const token=crypto.randomUUID();
 const consume=db.prepare(`UPDATE rig_customer_security_challenges SET used_at=?,use_token=?,credential_id=?,verified_counter=?
  WHERE id=? AND user_id=? AND operation='customer-generation' AND payload_hash=? AND payload_json=? AND used_at IS NULL AND attempted_at IS NULL AND expires_at>?
  AND EXISTS(SELECT 1 FROM rig_customer_credentials k WHERE k.user_id=? AND k.credential_id=? AND k.state='active' AND k.counter=? AND k.public_key=? AND k.fingerprint=?)
  AND EXISTS(SELECT 1 FROM rig_generation_quotes q WHERE ${quoteMatch('rig_customer_security_challenges','q')} AND q.expires_at>? AND ${identitySQL('q.user_id')})`)
  .bind(now,token,key.credential_id,counter,c.id,userId,operation.digest,operation.payloadJson,now,userId,key.credential_id,key.counter,key.public_key,key.fingerprint,now);
 const bump=db.prepare(`UPDATE rig_customer_credentials SET counter=?,last_verified_at=? WHERE user_id=? AND credential_id=? AND state='active' AND counter=? AND public_key=? AND fingerprint=?
  AND EXISTS(SELECT 1 FROM rig_customer_security_challenges WHERE id=? AND user_id=? AND use_token=? AND payload_hash=?)`).bind(counter,now,userId,key.credential_id,key.counter,key.public_key,key.fingerprint,c.id,userId,token,operation.digest);
 const gate={sql:`EXISTS(SELECT 1 FROM rig_customer_security_challenges c JOIN rig_customer_credentials k ON k.user_id=c.user_id AND k.credential_id=c.credential_id
  JOIN rig_generation_quotes q ON ${quoteMatch('c','q')}
  WHERE c.id=? AND c.user_id=? AND c.operation='customer-generation' AND c.payload_hash=? AND c.payload_json=? AND c.use_token=? AND c.used_at=? AND c.attempted_at IS NULL
   AND c.verified_counter=? AND k.counter=? AND k.state='active' AND k.public_key=? AND k.fingerprint=? AND c.expires_at>? AND q.expires_at>? AND ${identitySQL('c.user_id')})`,params:[c.id,userId,operation.digest,operation.payloadJson,token,now,counter,counter,key.public_key,key.fingerprint,now,now]};
 const event=db.prepare(`INSERT INTO rig_customer_security_audit(id,user_id,event,operation,payload_hash,credential_id,challenge_id,created_at)
  SELECT ?,?,'verification-consumed','customer-generation',?,?,?,? WHERE ${gate.sql}`).bind(crypto.randomUUID(),userId,operation.digest,key.credential_id,c.id,now,...gate.params);
 return {ok:true,required:true,before:[consume,bump,event],gate,challengeId:c.id,credentialId:key.credential_id};
}

export async function handleCustomerSecurity(req,env,{userId,now=Date.now()}={}){
 if(!USER.test(userId||'')||userId===env?.RIG_PRODUCTION_OWNER_USER_ID)return json({error:'Geen toegang.'},403);
 const mapped=await validateProductionTenant(env);if(!mapped)return json({error:'Beveiligingsinstellingen zijn tijdelijk niet beschikbaar.'},503);
 const url=new URL(req.url),db=mapped.DB,expectedOrigin=passkeyOrigin(env,CUSTOMER_ORIGIN);
 if(!expectedOrigin)return json({error:'Apparaatbevestiging is nog niet ingesteld voor deze app.',code:'native_security_not_configured'},503);
 if(url.origin!==CUSTOMER_ORIGIN||url.search||!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.get('origin')!==CUSTOMER_ORIGIN||!Number.isSafeInteger(now)||now<0)return json({error:'Aanvraag geweigerd.'},403);
 try{
  if(!(await db.prepare(`SELECT 1 AS found WHERE ${identitySQL('?')}`).bind(userId).first())?.found)return json({error:'Aanmelden vereist.'},403);
  if(await d1Limit({env:mapped,category:'customer-security',userId,method:req.method})!==true)return json({error:'Te veel aanvragen. Probeer later opnieuw.'},429);
  if(req.method==='GET'&&url.pathname==='/api/security'){
   const key=await active(db,userId);return json({configured:Boolean(key),required:true,activeCredentialCount:key?1:0,credentials:key?[publicCredential(key)]:[]});
  }
  if(req.method!=='POST')return json({error:'Niet gevonden.'},404);
  const data=await readJSON(req);if(!data)return json({error:'Controleer je aanvraag.'},400);
  if(url.pathname==='/api/security/registration/options'){
   if(!exact(data,['label'])||typeof data.label!=='string'||data.label.trim().length<1||data.label.length>80||/[\u0000-\u001f\u007f]/.test(data.label))return json({error:'Geef je passkey een korte naam.'},400);
   // A revoked key is still an enrollment. A session cannot replace or reset it.
   if(await enrolled(db,userId))return fail('credential_management_locked','Er is al een passkey ingesteld. Gebruik Hulp als je die niet meer kunt gebruiken.').response;
   await db.prepare('DELETE FROM rig_customer_security_challenges WHERE user_id=? AND expires_at<=? AND used_at IS NULL').bind(userId,now).run();
   const publicKey=await generateRegistrationOptions({rpName:'RIG',rpID:CUSTOMER_RP_ID,userName:userId,userDisplayName:'RIG gebruiker',userID:new TextEncoder().encode(userId),attestationType:'none',timeout:300000,authenticatorSelection:{residentKey:'required',userVerification:'required'},supportedAlgorithmIDs:[-7,-257]});
   const id=crypto.randomUUID(),expiresAt=now+300000,label=data.label.trim(),payload=JSON.stringify({label}),hash=await customerSecurityHash(payload);
   const result=await db.prepare(`INSERT INTO rig_customer_security_challenges(id,user_id,operation,challenge,payload_hash,payload_json,label,created_at,expires_at)
    SELECT ?,?,'registration',?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM rig_customer_credentials WHERE user_id=?)
    AND (SELECT COUNT(*) FROM rig_customer_security_challenges WHERE user_id=? AND operation='registration' AND expires_at>? AND used_at IS NULL AND attempted_at IS NULL)<3`)
    .bind(id,userId,publicKey.challenge,hash,payload,label,now,expiresAt,userId,userId,now).run();
   if(result.meta?.changes!==1)return json({error:'Er staan al beveiligingsaanvragen klaar. Wacht even en probeer opnieuw.'},429);
   return json({challengeId:id,publicKey,expiresAt},201);
  }
  if(url.pathname==='/api/security/registration/verify'){
   if(!exact(data,['challengeId','credential'])||!UUID.test(data.challengeId||''))return fail('verification_invalid','De passkey kon niet worden gecontroleerd.').response;
   if(await enrolled(db,userId))return fail('credential_management_locked','Er is al een passkey ingesteld. Gebruik Hulp als je die niet meer kunt gebruiken.').response;
   const c=await db.prepare("SELECT * FROM rig_customer_security_challenges WHERE id=? AND user_id=? AND operation='registration'").bind(data.challengeId,userId).first();
   if(!c||c.used_at!==null||c.attempted_at!==null||c.expires_at<=now)return fail('verification_expired','Deze registratie is verlopen. Begin opnieuw.').response;
   const claimed=await db.prepare('UPDATE rig_customer_security_challenges SET attempted_at=? WHERE id=? AND user_id=? AND attempted_at IS NULL AND used_at IS NULL AND expires_at>?').bind(now,c.id,userId,now).run();
   if(claimed.meta?.changes!==1)return fail('verification_invalid','Deze registratie is al gebruikt.').response;
   let verified;
   try{if(!validClientData(data.credential,'webauthn.create',expectedOrigin))throw Error('Wrong client data');verified=await verifyRegistrationResponse({response:data.credential,expectedChallenge:c.challenge,expectedOrigin,expectedRPID:CUSTOMER_RP_ID,requireUserPresence:true,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});if(!verified.verified||verified.registrationInfo.userVerified!==true)throw Error('User verification required');}catch{return fail('verification_invalid','De passkey kon niet worden gecontroleerd.').response;}
   const info=verified.registrationInfo,key=info.credential,publicKey=base64(key.publicKey),fingerprint=await customerSecurityHash(key.id+'\0'+publicKey),token=crypto.randomUUID();
   if(!B64.test(key.id)||key.id!==data.credential.id||!Number.isSafeInteger(key.counter)||key.counter<0)return fail('verification_invalid','De passkey kon niet worden gecontroleerd.').response;
   const consume=db.prepare(`UPDATE rig_customer_security_challenges SET used_at=?,use_token=?,credential_id=?,verified_counter=? WHERE id=? AND user_id=? AND operation='registration' AND attempted_at=? AND used_at IS NULL AND expires_at>?
    AND NOT EXISTS(SELECT 1 FROM rig_customer_credentials WHERE user_id=?)`).bind(now,token,key.id,key.counter,c.id,userId,now,now,userId);
   const install=db.prepare(`INSERT INTO rig_customer_credentials(credential_id,user_id,public_key,user_handle,counter,device_type,backed_up,transports_json,label,fingerprint,state,created_at,activated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,'active',?,? WHERE EXISTS(SELECT 1 FROM rig_customer_security_challenges WHERE id=? AND user_id=? AND use_token=? AND used_at=?)
    AND NOT EXISTS(SELECT 1 FROM rig_customer_credentials WHERE user_id=?)`).bind(key.id,userId,publicKey,base64(new TextEncoder().encode(userId)),key.counter,info.credentialDeviceType,info.credentialBackedUp?1:0,JSON.stringify((key.transports||[]).filter(x=>['usb','nfc','ble','internal','hybrid'].includes(x))),c.label,fingerprint,now,now,c.id,userId,token,now,userId);
   const event=db.prepare(`INSERT INTO rig_customer_security_audit(id,user_id,event,operation,payload_hash,credential_id,challenge_id,created_at)
    SELECT ?,?,'registration-active','registration',?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_customer_credentials WHERE user_id=? AND credential_id=? AND fingerprint=?)
    AND EXISTS(SELECT 1 FROM rig_customer_security_challenges WHERE id=? AND use_token=?)`).bind(crypto.randomUUID(),userId,c.payload_hash,key.id,c.id,now,userId,key.id,fingerprint,c.id,token);
   let result;try{result=await db.batch([consume,install,event]);}catch{return json({error:'Deze passkey kon niet worden ingesteld. Begin opnieuw.',code:'registration_conflict'},409);}
   if(result[1].meta?.changes!==1)return json({error:'Er is al een passkey ingesteld.',code:'credential_management_locked'},409);
   return json({configured:true,status:'active',credential:{id:key.id,label:c.label,createdAt:now,activatedAt:now}},201);
  }
  if(url.pathname==='/api/security/verification/options'){
   if(!exact(data,['operation','payload'])||data.operation!=='customer-generation')return json({error:'Controleer je aanvraag.'},400);
   let operation;try{operation=await generationOperation(db,userId,data.payload,now);}catch{return fail('operation_changed','Deze prijsopgave is gewijzigd of verlopen. Vraag opnieuw de prijs op.',409).response;}
   const key=await active(db,userId);if(!key)return fail('security_setup_required','Stel eerst je passkey in om een video te maken.').response;
   await db.prepare('DELETE FROM rig_customer_security_challenges WHERE user_id=? AND expires_at<=? AND used_at IS NULL').bind(userId,now).run();
   const publicKey=await generateAuthenticationOptions({rpID:CUSTOMER_RP_ID,timeout:120000,userVerification:'required',allowCredentials:[{id:key.credential_id,transports:JSON.parse(key.transports_json)}]}),id=crypto.randomUUID(),expiresAt=Math.min(now+120000,operation.q.expires_at),q=operation.q;
   const result=await db.prepare(`INSERT INTO rig_customer_security_challenges(id,user_id,operation,challenge,payload_hash,payload_json,quote_id,idempotency_key,quote_model,quote_input_json,quote_price_cents,quote_pricing_version,quote_duration_seconds,quote_expires_at,created_at,expires_at)
    SELECT ?,?,'customer-generation',?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
     EXISTS(SELECT 1 FROM rig_customer_credentials WHERE user_id=? AND credential_id=? AND state='active')
     AND (SELECT COUNT(*) FROM rig_customer_security_challenges WHERE user_id=? AND operation='customer-generation' AND expires_at>? AND used_at IS NULL AND attempted_at IS NULL)<5`)
    .bind(id,userId,publicKey.challenge,operation.digest,operation.payloadJson,q.id,operation.value.idempotencyKey,q.model,q.input_json,q.price_cents,q.pricing_version,q.duration_seconds,q.expires_at,now,expiresAt,userId,key.credential_id,userId,now).run();
   if(result.meta?.changes!==1)return json({error:'Er staan al bevestigingen klaar. Wacht even en probeer opnieuw.'},429);
   const quality=({standard:'Standaard',pro:'Pro','edit-standard':'Videobewerking','human-recast':'Personen vervangen'})[JSON.parse(q.input_json)?.data?.quality]||'Video';
   const summary=`Video starten: ${q.duration_seconds} seconden, ${quality}, €${(q.price_cents/100).toFixed(2)} RIG-tegoed. ${operation.value.transferConsent?'Tijdelijke Fal-links voor je media (24 uur). ':''}Opdracht ${q.id}.`;
   return json({required:true,challengeId:id,publicKey,expiresAt,summary},201);
  }
  return json({error:'Niet gevonden.'},404);
 }catch{return json({error:'De beveiligingscontrole is tijdelijk niet beschikbaar.'},503);}
}
