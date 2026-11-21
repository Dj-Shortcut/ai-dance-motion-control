const MAX_INPUT = 3 * 1024 * 1024;
export const START_PHOTO_BODY_MAX = MAX_INPUT + 8192;
const MAX_OUTPUT = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const USER = /^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MODEL = 'gpt-image-2.6-sunburst';
const EDIT_URL = 'https://api.openai.com/v1/images/edits';
class SponsorshipExhausted extends Error {}
const headers = {'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json = (value,status=200) => Response.json(value,{status,headers});

const activeCustomer = `EXISTS (
 SELECT 1 FROM rig_sites_identities i
 WHERE i.site_id=? AND i.subject_hash=? AND i.user_id=?
 AND EXISTS (SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
 AND NOT EXISTS (SELECT 1 FROM rig_frozen_accounts f WHERE f.user_id=i.user_id)
)`;

async function campaign(env,db,session,now) {
 const {siteId,subjectHash,userId}=session;
 const expires=Date.parse(env.RIG_START_PHOTO_EXPIRES_AT);
 if (env.RIG_START_PHOTO_SPEND_POLICY!=='serialized-150-v1' ||
     !/^sk-[A-Za-z0-9_-]+$/.test(env.RIG_OPENAI_IMAGES_KEY ?? '') ||
     typeof siteId!=='string' || siteId!==env.RIG_PRODUCTION_SITE_ID ||
     typeof subjectHash!=='string' || !/^[a-f0-9]{64}$/.test(subjectHash) ||
     !Number.isFinite(expires) || expires<=now || !USER.test(userId)) return null;
 const identity=[siteId,subjectHash,userId];
 if (!(await db.prepare(`SELECT 1 WHERE ${activeCustomer}`).bind(...identity).first())) return null;
 return {expires,identity};
}

async function bounded(body,limit,signal) {
 if (!body) throw Error('missing body');
 const reader=body.getReader();
 const chunks=[];
 let size=0;
 let abort;
 const timeout=new Promise((_,reject)=>{
  abort=()=>reject(new Error('timeout'));
  signal.addEventListener('abort',abort,{once:true});
 });
 try {
  if (signal.aborted) throw Error('timeout');
  while (true) {
   const {done,value}=await Promise.race([reader.read(),timeout]);
   if (done) break;
   size+=value.byteLength;
   if (size>limit || chunks.length>=4096) throw Error('size');
   chunks.push(value);
  }
  const result=new Uint8Array(size);
  let offset=0;
  for (const chunk of chunks) {
   result.set(chunk,offset);
   offset+=chunk.byteLength;
  }
  return result;
 } finally {
  signal.removeEventListener('abort',abort);
  void reader.cancel().catch(()=>{});
 }
}

function isJpeg(bytes) {
 return bytes.length>4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 &&
  bytes.at(-2)===255 && bytes.at(-1)===217;
}

// Both clients flatten the selected photo into a JPEG before submitting it.
// Check the actual frame dimensions here, before claiming the global spend slot.
function normalizedPhoto(bytes) {
 if (!isJpeg(bytes)) return false;
 let position=2,foundFrame=false;
 while (position+3<bytes.length) {
  if (bytes[position++]!==255) return false;
  while (bytes[position]===255) position++;
  const marker=bytes[position++];
  if (marker===0xda) return foundFrame;
  if (marker===0xd8 || marker===0xd9 || marker===0x00) return false;
  const length=bytes[position]*256+bytes[position+1];
  if (length<2 || position+length>bytes.length) return false;
  if (marker>=0xc0 && marker<=0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
   if (foundFrame || ![0xc0,0xc1,0xc2].includes(marker) || length<8) return false;
   const height=bytes[position+3]*256+bytes[position+4];
   const width=bytes[position+5]*256+bytes[position+6];
   if (!height || !width || height>2048 || width>2048) return false;
   foundFrame=true;
  }
  position+=length;
 }
 return false;
}

async function readPhotoRequest(req) {
 const contentType=req.headers.get('content-type') ?? '';
 if (contentType.length>256 || !/^multipart\/form-data;\s*boundary=/i.test(contentType)) return null;
 const length=req.headers.get('content-length');
 if (length!==null && (!/^\d+$/.test(length) || Number(length)>START_PHOTO_BODY_MAX)) return null;
 try {
  const bytes=await bounded(req.body,START_PHOTO_BODY_MAX,AbortSignal.timeout(10000));
  if (length!==null && Number(length)!==bytes.length) return null;
  const form=await new Response(bytes,{headers:{'content-type':contentType}}).formData();
  const [mode,prompt,requestId,photo]=['mode','prompt','requestId','image'].map(key=>form.get(key));
  if (!['create','edit'].includes(mode) || typeof prompt!=='string' || !prompt.trim() || prompt.trim().length>400 ||
      typeof requestId!=='string' || !UUID.test(requestId) || [...form.keys()].length!==(mode==='edit'?4:3)) return null;
  if (mode==='edit' && (!(photo instanceof Blob) || photo.type!=='image/jpeg' || photo.size>MAX_INPUT ||
      !normalizedPhoto(new Uint8Array(await photo.arrayBuffer())))) return null;
  if (mode==='create' && photo!==null) return null;
  return {mode,prompt:prompt.trim(),requestId,photo};
 } catch {return null;}
}

async function claimEdit(db,userId,requestId,now,identity) {
 // The database trigger checks all clients and the total in the same write.
 const result=await db.prepare(`INSERT INTO rig_start_photo_edits(request_id,user_id,created_at)
  SELECT ?,?,? WHERE ${activeCustomer} ON CONFLICT(request_id) DO NOTHING`)
  .bind(requestId,userId,now,...identity).run();
 if (result.meta?.changes===1) return 'claimed';
 if (!(await db.prepare(`SELECT 1 WHERE ${activeCustomer}`).bind(...identity).first())) return 'denied';
 const prior=await db.prepare(`SELECT request_id FROM rig_start_photo_edits WHERE request_id=?
  UNION ALL SELECT request_id FROM rig_start_photo_attempts WHERE request_id=?`).bind(requestId,requestId).first();
 return prior?'duplicate':'unavailable';
}

// USD per million tokens equals microdollars per token. Use the published standard
// tariff for the fixed Sunburst model without subtracting cache discounts. For this
// USD credit grant the campaign counts US$1 as €1 and rounds each edit up to a cent.
function accountedUsage(result) {
 const usage=result.usage;
 if (!usage || result.svg_usage!=null || (result.model!=null && result.model!==MODEL)) return null;
 const text=usage.input_tokens_details?.text_tokens,image=usage.input_tokens_details?.image_tokens;
 const output=usage.output_tokens,details=usage.output_tokens_details;
 if (![text,image,output,usage.input_tokens,usage.total_tokens].every(n=>Number.isSafeInteger(n)&&n>=0) ||
     text+image!==usage.input_tokens || usage.input_tokens+output!==usage.total_tokens ||
     text===0 || image===0 || output===0) return null;
 if (details!=null && (details.text_tokens!==0 || details.image_tokens!==output)) return null;
 const micros=5*text+8*image+30*output;
 if (!Number.isSafeInteger(micros)) return null;
 return {text,image,output,micros,cents:Math.ceil(micros/10000)};
}

async function editPhoto(input,env,session,network,db) {
 const label='Edit the attached start photograph for a motion-controlled video. Keep the subject recognizable and preserve pose and framing unless requested otherwise. Apply this edit:';
 const form=new FormData();
 for (const [name,value] of Object.entries({model:MODEL,prompt:`${label}\n${input.prompt}`,size:'1024x1536',
  quality:'medium',output_format:'jpeg',n:'1',safety_identifier:session.subjectHash})) form.set(name,value);
 form.set('image',input.photo,'startfoto.jpg');
 const signal=AbortSignal.timeout(75000);
 const response=await network(EDIT_URL,{method:'POST',body:form,signal,redirect:'manual',
  headers:{authorization:`Bearer ${env.RIG_OPENAI_IMAGES_KEY}`,'X-Client-Request-Id':input.requestId}});
 const providerId=response.headers.get('x-request-id');
 if (providerId && /^[a-zA-Z0-9._:-]{1,200}$/.test(providerId)) {
  await db.prepare('UPDATE rig_start_photo_edits SET provider_request_id=? WHERE request_id=?')
   .bind(providerId,input.requestId).run();
 }
 if (!response.ok) {
  if (response.status===429) {
   const error=await bounded(response.body,8192,signal)
    .then(bytes=>JSON.parse(new TextDecoder().decode(bytes))).catch(()=>null);
   if (error?.error?.code==='credit_balance_exhausted') throw new SponsorshipExhausted();
  } else {
   void response.body?.cancel().catch(()=>{});
  }
  throw Error('provider');
 }
 const bytes=await bounded(response.body,Math.ceil(MAX_OUTPUT/3)*4+16384,signal);
 const result=JSON.parse(new TextDecoder().decode(bytes));
 const usage=accountedUsage(result);
 if (usage) {
  const updated=await db.prepare(`UPDATE rig_start_photo_edits SET
   text_input_tokens=?,image_input_tokens=?,output_tokens=?,cost_usd_micros=?,cost_eur_cents=?
   WHERE request_id=? AND cost_eur_cents IS NULL`)
   .bind(usage.text,usage.image,usage.output,usage.micros,usage.cents,input.requestId).run();
  if (updated.meta?.changes!==1) throw Error('settlement');
 }
 // A delivered image can still be used if OpenAI omitted usage. The unpriced row
 // retains the sole slot until actual charges can be reconciled.
 const b64=result.data?.[0]?.b64_json;
 if (typeof b64!=='string' || b64.length>Math.ceil(MAX_OUTPUT/3)*4) throw Error('image');
 const jpeg=Uint8Array.from(atob(b64),char=>char.charCodeAt(0));
 if (jpeg.length>MAX_OUTPUT || !isJpeg(jpeg)) throw Error('image');
 return jpeg;
}

export async function handleNativeStartPhoto(req,env,{db,session,network,now=Date.now()}) {
 const offer=await campaign(env,db,session,now);
 if (req.method==='GET') {
  const budget=offer?await db.prepare('SELECT accounted_eur_cents,unpriced_count FROM rig_start_photo_budget').first():null;
  const canEdit=Number.isSafeInteger(budget?.accounted_eur_cents) && budget.accounted_eur_cents<15000;
  const waiting=canEdit && budget.unpriced_count>0;
  // Existing Android clients require a positive availability sentinel.
  return json({enabled:canEdit,available:canEdit,remaining:canEdit?3:0,canEdit,canCreate:false,waiting});
 }
 if (!offer) return json({error:'De gesponsorde fotobewerking is niet beschikbaar.'},403);
 const input=await readPhotoRequest(req);
 if (!input) return json({error:'Controleer je beschrijving en foto. Kies een foto van maximaal 3 MB.'},400);
 if (input.mode!=='edit') return json({error:'Kies een bestaande foto om die te bewerken.'},403);
 const claimTime=Date.now();
 if (claimTime>=offer.expires) return json({error:'De gesponsorde periode is afgelopen.'},403);
 const claim=await claimEdit(db,session.userId,input.requestId,claimTime,offer.identity);
 if (claim==='denied') return json({error:'De gesponsorde fotobewerking is niet beschikbaar.'},403);
 if (claim==='duplicate') return json({error:'Deze aanvraag is al ingediend.'},409);
 if (claim!=='claimed') {
  const budget=await db.prepare('SELECT accounted_eur_cents FROM rig_start_photo_budget').first();
  if (budget?.accounted_eur_cents>=15000) return json({error:'Het gesponsorde fotobudget is op.'},429);
  return json({error:'RIG wacht op de kosten van een eerdere fotobewerking. Probeer het later opnieuw.'},429);
 }
 try {
  const jpeg=await editPhoto(input,env,session,network,db);
  return new Response(jpeg,{headers:{...headers,'content-type':'image/jpeg','content-length':String(jpeg.length)}});
 } catch (error) {
  if (error instanceof SponsorshipExhausted) return json({error:'Het OpenAI-tegoed voor fotobewerkingen is op.'},429);
  return json({error:'De foto kon niet worden opgehaald. Controleer later of de fotobewerking weer beschikbaar is.'},502);
 }
}
