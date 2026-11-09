// Private owner verification. A logged-in session cannot activate its own key.
import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
import {profitPolicyRow} from './profit-policy.mjs';

export const OWNER_RP_ID='rig-motion-studio.shortcutcomputerguy.chatgpt.site';
export const OWNER_ORIGIN='https://'+OWNER_RP_ID;
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64=/^[A-Za-z0-9_-]{1,2048}$/;
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const VERSION=/^[A-Za-z0-9_.-]{1,64}$/;
const expenseCategories=new Set(['fal-charge','fal-topup','mollie','hosting','other','refund']);
const policyNames=['expectedVersion','eurPerUsdMicros','providerVatBps','paymentFeeBps','failureBufferBps','preparationCents','minMarginBps','dailyProviderLimitUsdMicros','minPriceCents','minProPriceCents'];
const policyColumns=['eur_per_usd_micros','provider_vat_bps','payment_fee_bps','failure_buffer_bps','preparation_cents','min_margin_bps','daily_provider_limit_usd_micros','min_price_cents','min_pro_price_cents'];
const operations=new Set(['finance-policy','finance-expense','owner-generation']);
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const fail=(code,message,status=428)=>({ok:false,response:json({error:message,code},status)});
const base64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const unbase64=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),x=>x.charCodeAt(0));
export const ownerSecurityHash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
const credentialMeta=row=>({id:row.credential_id,candidateId:row.candidate_id,label:row.label,fingerprint:row.fingerprint,createdAt:row.created_at,activatedAt:row.activated_at});
const candidateMeta=(row,now)=>({candidateId:row.candidate_id,label:row.label,fingerprint:row.fingerprint,status:row.state==='active'?'active':row.state!=='pending'?'rejected':row.expires_at<=now?'expired':'pending',expiresAt:row.expires_at});
function canonical(operation,payload){
 if(!operations.has(operation)||!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid operation');
 const keys=Object.keys(payload),allowed=operation==='finance-policy'?policyNames:operation==='finance-expense'?['idempotencyKey','category','date','amountCents','note','jobId','replacesExpenseId']:['quoteId','idempotencyKey','transferConsent'];
 if(keys.length===0||keys.some(k=>!allowed.includes(k)))throw Error('Invalid operation');
 const out={};for(const key of keys.sort()){const value=payload[key];if(typeof value==='string'){if(value.length>2048||/[\u0000-\u001f\u007f]/.test(value))throw Error('Invalid string');}else if(!Number.isSafeInteger(value))throw Error('Invalid value');out[key]=value;}
 if(operation==='finance-policy'){
  if(keys.length!==policyNames.length||policyNames.some(k=>!Object.hasOwn(payload,k))||!VERSION.test(payload.expectedVersion||''))throw Error('Incomplete policy');
  profitPolicyRow({...payload,version:payload.expectedVersion});
 }
 if(operation==='finance-expense'){
  if(['idempotencyKey','category','date','amountCents','note'].some(k=>!Object.hasOwn(payload,k))||!UUID.test(payload.idempotencyKey||'')||!expenseCategories.has(payload.category)||!/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(payload.date||'')||new Date(payload.date+'T00:00:00Z').toISOString().slice(0,10)!==payload.date||!Number.isSafeInteger(payload.amountCents)||payload.amountCents<0||payload.amountCents>100000000||typeof payload.note!=='string'||Array.from(payload.note.trim()).length<1||Array.from(payload.note).length>240||Object.hasOwn(payload,'replacesExpenseId')&&!UUID.test(payload.replacesExpenseId)||(payload.category==='fal-charge'?(typeof payload.jobId!=='string'||!ID.test(payload.jobId)):Object.hasOwn(payload,'jobId')))throw Error('Invalid expense');
 }
 if(operation==='owner-generation'&&(!UUID.test(payload.quoteId||'')||typeof payload.idempotencyKey!=='string'||!ID.test(payload.idempotencyKey)||Object.hasOwn(payload,'transferConsent')&&payload.transferConsent!=='fal-temporary-links-v1'))throw Error('Invalid generation');
 return JSON.stringify(out);
}
export async function ownerMutationDigest(operation,payload){return ownerSecurityHash(operation+'\0'+canonical(operation,payload));}
async function safeDecrease(db,operation,payload){
 if(operation!=='finance-policy')return false;
 const row=await db.prepare('SELECT * FROM rig_finance_policy WHERE id=1').first();
 return Boolean(row&&row.version===payload.expectedVersion&&Number.isSafeInteger(payload.dailyProviderLimitUsdMicros)&&payload.dailyProviderLimitUsdMicros>=100000&&payload.dailyProviderLimitUsdMicros<row.daily_provider_limit_usd_micros&&policyNames.slice(1).every((name,i)=>name==='dailyProviderLimitUsdMicros'||payload[name]===row[policyColumns[i]]));
}
function validClientData(credential,type){
 if(!credential||typeof credential!=='object'||Array.isArray(credential)||credential.type!=='public-key'||!B64.test(credential.id||'')||credential.rawId!==credential.id)return false;
 const encoded=credential.response?.clientDataJSON;if(!B64.test(encoded||''))return false;
 try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(unbase64(encoded)));return data.type===type&&data.origin===OWNER_ORIGIN&&data.crossOrigin===false&&!Object.hasOwn(data,'topOrigin');}catch{return false;}
}
async function readJSON(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;let size=0,parts=[];
 try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8192)return null;parts.push(r.value);}const out=new Uint8Array(size);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(out));return data&&typeof data==='object'&&!Array.isArray(data)?data:null;}catch{return null;}finally{void reader.cancel().catch(()=>{});}
}
const exact=(value,keys)=>value&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
async function active(db,ownerId){return (await db.prepare("SELECT * FROM rig_owner_credentials WHERE owner_id=? AND state='active' ORDER BY created_at LIMIT 5").bind(ownerId).all()).results;}
async function audit(db,ownerId,event,operation,payloadHash,credentialId,candidateId,now){await db.prepare('INSERT INTO rig_owner_security_audit(id,owner_id,event,operation,payload_hash,credential_id,candidate_id,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),ownerId,event,operation,payloadHash,credentialId,candidateId,now).run();}
async function rejectAssertion(db,challenge,now){
 await db.prepare('UPDATE rig_owner_security_challenges SET attempted_at=? WHERE id=? AND owner_id=? AND used_at IS NULL AND attempted_at IS NULL').bind(now,challenge.id,challenge.owner_id).run();
 return fail('verification_invalid','De passkey kon niet worden gecontroleerd.');
}
async function operationSummary(db,ownerId,operation,payload,now){
 if(operation==='finance-policy'){
  const row=await db.prepare('SELECT * FROM rig_finance_policy WHERE id=1').first();if(!row||row.version!==payload.expectedVersion)throw Error('Policy changed');
  const labels=['Wisselkoers EUR per USD','Reserve btw','Reserve betaling','Reserve mislukkingen','Voorbereiding','Minimummarge','Daglimiet Fal','Minimumprijs standaard','Minimumprijs Pro'];
  const format=(name,value)=>name==='eurPerUsdMicros'?'€'+(value/1000000).toFixed(6):name==='dailyProviderLimitUsdMicros'?'US$'+(value/1000000).toFixed(2):name.endsWith('Bps')?(value/100).toFixed(2)+'%':'€'+(value/100).toFixed(2);
  const changed=policyNames.slice(1).flatMap((name,i)=>payload[name]===row[policyColumns[i]]?[]:[labels[i]+': '+format(name,row[policyColumns[i]])+' → '+format(name,payload[name])]);
  return changed.length?'Beheerinstellingen wijzigen. '+changed.join('; ')+'.':'Beheerinstellingen opnieuw bewaren zonder waardewijziging.';
 }
 if(operation==='finance-expense')return `${payload.replacesExpenseId?'Kosten corrigeren':'Kosten registreren'}: €${(payload.amountCents/100).toFixed(2)}; ${payload.category}; ${payload.date}; ${payload.note}${payload.jobId?'; video '+payload.jobId:''}${payload.replacesExpenseId?'; vervangt '+payload.replacesExpenseId:''}.`;
 const row=await db.prepare("SELECT duration_seconds,input_json,model FROM rig_generation_quotes WHERE id=? AND user_id=? AND funding_kind='owner-provider' AND expires_at>?").bind(payload.quoteId,ownerId,now).first();
 const input=row&&JSON.parse(row.input_json),usd=input?.providerEstimateUsdMicros;
 if(!row||typeof row.duration_seconds!=='number'||row.duration_seconds<=0||row.duration_seconds>30||!Number.isSafeInteger(usd)||usd<=0||usd>6000000)throw Error('Quote unavailable');
 return `Video starten: ${row.duration_seconds} seconden; raming US$${(usd/1000000).toFixed(2)} uit je eigen Fal-tegoed. ${payload.transferConsent?'Tijdelijke Fal-links voor je media (24 uur). ':''}Opdracht ${payload.quoteId}.`;
}

// Caller must authorize the pinned owner before using this helper. Every SQL
// mutation must be gated with gate.sql/params in the same batch as before.
export async function prepareOwnerMutation(db,{ownerId,operation,payload,verification,now=Date.now()}={}){
 if(!USER.test(ownerId||'')||!Number.isSafeInteger(now))return fail('verification_invalid','Bevestiging is niet beschikbaar.');
 let digest;try{digest=await ownerMutationDigest(operation,payload);}catch{return fail('verification_invalid','Controleer de beheerwijziging.',400);}
 if(await safeDecrease(db,operation,payload))return {ok:true,before:[],gate:{sql:'1',params:[]},required:false};
 const keys=await active(db,ownerId);if(!keys.length)return fail('security_setup_required','Stel eerst je beheerderspasskey in.');
 if(!exact(verification,['challengeId','credential'])||!UUID.test(verification.challengeId||''))return fail('step_up_required','Bevestig deze wijziging met je passkey.');
 const challenge=await db.prepare('SELECT * FROM rig_owner_security_challenges WHERE id=? AND owner_id=?').bind(verification.challengeId,ownerId).first();
 if(!challenge||challenge.operation!==operation||challenge.payload_hash!==digest||challenge.used_at!==null||challenge.attempted_at!==null)return fail('verification_invalid','Deze bevestiging is niet geldig. Vraag een nieuwe bevestiging.');
 if(challenge.expires_at<=now)return fail('verification_expired','De bevestiging is verlopen. Probeer opnieuw.');
 const key=keys.find(row=>row.credential_id===verification.credential?.id);
 if(!key||!validClientData(verification.credential,'webauthn.get'))return rejectAssertion(db,challenge,now);
 let proof;
 try{
  const handle=verification.credential.response?.userHandle;if(handle!==null&&handle!==undefined&&handle!==key.user_handle)throw Error('Wrong user handle');
  proof=await verifyAuthenticationResponse({response:verification.credential,expectedChallenge:challenge.challenge,expectedOrigin:OWNER_ORIGIN,expectedRPID:OWNER_RP_ID,requireUserVerification:true,credential:{id:key.credential_id,publicKey:unbase64(key.public_key),counter:key.counter,transports:JSON.parse(key.transports_json)}});
  if(!proof.verified||proof.authenticationInfo.userVerified!==true)throw Error('Not verified');
 }catch{return rejectAssertion(db,challenge,now);}
 const counter=proof.authenticationInfo.newCounter;if(!Number.isSafeInteger(counter)||counter<0)return fail('verification_invalid','De passkey kon niet worden gecontroleerd.');
 const token=crypto.randomUUID(),id=challenge.id;
 const consume=db.prepare(`UPDATE rig_owner_security_challenges SET used_at=?,use_token=?,credential_id=?,verified_counter=?
  WHERE id=? AND owner_id=? AND operation=? AND payload_hash=? AND used_at IS NULL AND attempted_at IS NULL AND expires_at>?
  AND EXISTS(SELECT 1 FROM rig_owner_credentials k WHERE k.owner_id=? AND k.credential_id=? AND k.state='active' AND k.counter=?)`)
  .bind(now,token,key.credential_id,counter,id,ownerId,operation,digest,now,ownerId,key.credential_id,key.counter);
 const bump=db.prepare(`UPDATE rig_owner_credentials SET counter=?,last_verified_at=? WHERE owner_id=? AND credential_id=? AND state='active' AND counter=?
  AND EXISTS(SELECT 1 FROM rig_owner_security_challenges WHERE id=? AND use_token=? AND owner_id=? AND payload_hash=?)`).bind(counter,now,ownerId,key.credential_id,key.counter,id,token,ownerId,digest);
 const gate={sql:`EXISTS(SELECT 1 FROM rig_owner_security_challenges c JOIN rig_owner_credentials k ON k.credential_id=c.credential_id AND k.owner_id=c.owner_id
  WHERE c.id=? AND c.owner_id=? AND c.operation=? AND c.payload_hash=? AND c.use_token=? AND c.used_at=? AND c.verified_counter=? AND k.counter=? AND k.state='active')`,params:[id,ownerId,operation,digest,token,now,counter,counter]};
 const event=db.prepare(`INSERT INTO rig_owner_security_audit(id,owner_id,event,operation,payload_hash,credential_id,candidate_id,created_at)
  SELECT ?,?,'verification-consumed',?,?,?,NULL,? WHERE ${gate.sql}`).bind(crypto.randomUUID(),ownerId,operation,digest,key.credential_id,now,...gate.params);
 return {ok:true,required:true,before:[consume,bump,event],gate,challengeId:id,credentialId:key.credential_id};
}

export async function handleOwnerSecurity(req,env,{userId,now=Date.now()}={}){
 if(!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return json({error:'Geen toegang.'},403);
 const mapped=await validateProductionTenant(env);if(!mapped)return json({error:'Beveiligingsinstellingen zijn tijdelijk niet beschikbaar.'},503);
 const url=new URL(req.url),db=mapped.DB;
 if(url.origin!==OWNER_ORIGIN||url.search||!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.get('origin')!==OWNER_ORIGIN)return json({error:'Aanvraag geweigerd.'},403);
 try{
  if(await d1Limit({env:mapped,category:'owner-security',userId,method:req.method})!==true)return json({error:'Te veel aanvragen. Probeer later opnieuw.'},429);
  if(req.method==='GET'&&url.pathname==='/api/owner/security'){
   const credentials=await active(db,userId),pending=(await db.prepare("SELECT * FROM rig_owner_credentials WHERE owner_id=? AND state='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 5").bind(userId,now).all()).results;
   return json({configured:credentials.length>0,activeCredentialCount:credentials.length,credentials:credentials.map(credentialMeta),pendingRegistrations:pending.map(row=>candidateMeta(row,now))});
  }
  const match=/^\/api\/owner\/security\/registration\/([0-9a-f-]{36})$/.exec(url.pathname);
  if(req.method==='GET'&&match&&UUID.test(match[1])){const row=await db.prepare('SELECT * FROM rig_owner_credentials WHERE candidate_id=? AND owner_id=?').bind(match[1],userId).first();return row?json(candidateMeta(row,now)):json({error:'Aanvraag niet gevonden.'},404);}
  if(req.method!=='POST')return json({error:'Niet gevonden.'},404);
  const data=await readJSON(req);if(!data)return json({error:'Controleer je aanvraag.'},400);
  if(url.pathname==='/api/owner/security/registration/options'){
   if(!exact(data,['label'])||typeof data.label!=='string'||data.label.trim().length<1||data.label.length>80||/[\u0000-\u001f\u007f]/.test(data.label))return json({error:'Geef je passkey een korte naam.'},400);
   if((await active(db,userId)).length)return json({error:'Gebruik de onafhankelijke beheerprocedure om een extra passkey toe te voegen.',code:'credential_management_locked'},428);
   const count=await db.prepare("SELECT COUNT(*) n FROM rig_owner_security_challenges WHERE owner_id=? AND operation='registration' AND expires_at>? AND used_at IS NULL AND attempted_at IS NULL").bind(userId,now).first();if(count.n>=3)return json({error:'Er staan al beveiligingsaanvragen klaar. Wacht even en probeer opnieuw.'},429);
   const publicKey=await generateRegistrationOptions({rpName:'RIG beheer',rpID:OWNER_RP_ID,userName:'RIG eigenaar',userDisplayName:'RIG eigenaar',userID:new TextEncoder().encode(userId),attestationType:'none',timeout:300000,authenticatorSelection:{residentKey:'required',userVerification:'required'},supportedAlgorithmIDs:[-7]});
   const id=crypto.randomUUID(),expiresAt=now+300000,payload=JSON.stringify({label:data.label.trim()}),hash=await ownerSecurityHash(payload);
   await db.prepare('INSERT INTO rig_owner_security_challenges(id,owner_id,operation,challenge,payload_hash,payload_json,label,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,userId,'registration',publicKey.challenge,hash,payload,data.label.trim(),now,expiresAt).run();
   return json({challengeId:id,publicKey,expiresAt},201);
  }
  if(url.pathname==='/api/owner/security/registration/verify'){
   if(!exact(data,['challengeId','credential'])||!UUID.test(data.challengeId||'')||!validClientData(data.credential,'webauthn.create'))return json({error:'De passkey kon niet worden gecontroleerd.',code:'verification_invalid'},428);
   const c=await db.prepare("SELECT * FROM rig_owner_security_challenges WHERE id=? AND owner_id=? AND operation='registration'").bind(data.challengeId,userId).first();if(!c||c.used_at!==null||c.attempted_at!==null||c.expires_at<=now)return json({error:'Deze registratie is verlopen. Begin opnieuw.',code:'verification_expired'},428);
   const claimed=await db.prepare('UPDATE rig_owner_security_challenges SET attempted_at=? WHERE id=? AND owner_id=? AND attempted_at IS NULL AND used_at IS NULL AND expires_at>?').bind(now,c.id,userId,now).run();if(claimed.meta?.changes!==1)return json({error:'Deze registratie is al gebruikt.',code:'verification_invalid'},428);
   let verified;try{verified=await verifyRegistrationResponse({response:data.credential,expectedChallenge:c.challenge,expectedOrigin:OWNER_ORIGIN,expectedRPID:OWNER_RP_ID,requireUserPresence:true,requireUserVerification:true,supportedAlgorithmIDs:[-7]});if(!verified.verified||verified.registrationInfo.userVerified!==true)throw Error('Not verified');}catch{return json({error:'De passkey kon niet worden gecontroleerd.',code:'verification_invalid'},428);}
   const info=verified.registrationInfo,key=info.credential,candidateId=crypto.randomUUID(),publicKey=base64(key.publicKey),fingerprint=await ownerSecurityHash(key.id+'\0'+publicKey),expiresAt=now+900000;
   if(!B64.test(key.id)||key.id!==data.credential.id||!Number.isSafeInteger(key.counter))return json({error:'De passkey kon niet worden gecontroleerd.'},428);
   try{
    const result=await db.prepare(`INSERT INTO rig_owner_credentials(candidate_id,owner_id,credential_id,public_key,user_handle,counter,device_type,backed_up,transports_json,label,fingerprint,state,created_at,expires_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE NOT EXISTS(SELECT 1 FROM rig_owner_credentials WHERE owner_id=? AND state='active')
     AND (SELECT COUNT(*) FROM rig_owner_credentials WHERE owner_id=? AND state='pending' AND expires_at>?)<3`)
     .bind(candidateId,userId,key.id,publicKey,base64(new TextEncoder().encode(userId)),key.counter,info.credentialDeviceType,info.credentialBackedUp?1:0,JSON.stringify((key.transports||[]).filter(x=>['usb','nfc','ble','internal','hybrid'].includes(x))),c.label,fingerprint,now,expiresAt,userId,userId,now).run();
    if(result.meta?.changes!==1)throw Error('Registration blocked');
    await db.prepare('UPDATE rig_owner_security_challenges SET used_at=? WHERE id=? AND owner_id=? AND attempted_at=?').bind(now,c.id,userId,now).run();
    await audit(db,userId,'registration-pending','registration',c.payload_hash,key.id,candidateId,now);
   }catch{return json({error:'Deze passkey kon niet worden klaargezet. Begin opnieuw.'},409);}
   return json({candidateId,fingerprint,label:c.label,status:'pending',expiresAt},201);
  }
  if(url.pathname==='/api/owner/security/verification/options'){
   if(!exact(data,['operation','payload']))return json({error:'Controleer de beheerwijziging.'},400);
   let payload,digest;try{payload=canonical(data.operation,data.payload);digest=await ownerMutationDigest(data.operation,data.payload);}catch{return json({error:'Controleer de beheerwijziging.'},400);}
   if(await safeDecrease(db,data.operation,data.payload))return json({required:false});
   const keys=await active(db,userId);if(!keys.length)return fail('security_setup_required','Stel eerst je beheerderspasskey in.').response;
   let summary;try{summary=await operationSummary(db,userId,data.operation,data.payload,now);}catch{return json({error:'Deze opdracht of beheerinstelling is niet meer beschikbaar. Vernieuw en probeer opnieuw.'},409);}
   const count=await db.prepare("SELECT COUNT(*) n FROM rig_owner_security_challenges WHERE owner_id=? AND operation<>'registration' AND expires_at>? AND used_at IS NULL AND attempted_at IS NULL").bind(userId,now).first();if(count.n>=5)return json({error:'Er staan al bevestigingen klaar. Wacht even en probeer opnieuw.'},429);
   const publicKey=await generateAuthenticationOptions({rpID:OWNER_RP_ID,timeout:120000,userVerification:'required',allowCredentials:keys.map(row=>({id:row.credential_id,transports:JSON.parse(row.transports_json)}))}),id=crypto.randomUUID(),expiresAt=now+120000;
   await db.prepare('INSERT INTO rig_owner_security_challenges(id,owner_id,operation,challenge,payload_hash,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,userId,data.operation,publicKey.challenge,digest,payload,now,expiresAt).run();
   return json({required:true,challengeId:id,publicKey,expiresAt,summary},201);
  }
  return json({error:'Niet gevonden.'},404);
 }catch{return json({error:'De beveiligingscontrole is tijdelijk niet beschikbaar.'},503);}
}
