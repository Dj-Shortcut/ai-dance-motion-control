const MAX_INPUT = 3 * 1024 * 1024;
export const START_PHOTO_BODY_MAX = MAX_INPUT + 8192;
const MAX_OUTPUT = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const USER = /^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MODEL = 'gpt-image-2.6-sunburst';
const API = 'https://api.openai.com/v1/images/';
class SponsorshipExhausted extends Error {}
const headers = {'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json = (value,status=200) => Response.json(value,{status,headers});

function campaign(env,userId,now) {
 const expires = Date.parse(env.RIG_START_PHOTO_EXPIRES_AT);
 if (!/^sk-[A-Za-z0-9_-]+$/.test(env.RIG_OPENAI_IMAGES_KEY ?? '') ||
     !Number.isFinite(expires) || expires <= now ||
     !(env.RIG_START_PHOTO_TESTERS ?? '').split(',').map(id=>id.trim()).some(id=>USER.test(id) && id===userId)) return null;
 return expires;
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
      !isJpeg(new Uint8Array(await photo.arrayBuffer())))) return null;
  if (mode==='create' && photo!==null) return null;
  return {mode,prompt:prompt.trim(),requestId,photo};
 } catch {return null;}
}

async function reserve(db,userId,requestId,now) {
 const claim=await db.prepare('INSERT OR IGNORE INTO rig_start_photo_attempts(request_id,user_id,created_at) VALUES (?,?,?)')
  .bind(requestId,userId,now).run();
 return claim.meta?.changes===1;
}

async function generate(input,env,session,network) {
 const label=input.mode==='create'
  ? 'Create a single vertical full-body start photograph for a motion-controlled video. Keep hands and feet in frame, one main subject, legible pose and no text. Follow this character description:'
  : 'Edit the attached start photograph for a motion-controlled video. Keep the subject recognizable and preserve pose and framing unless requested otherwise. Apply this edit:';
 const fields={model:MODEL,prompt:`${label}\n${input.prompt}`,size:'1024x1536',quality:'medium',output_format:'jpeg',n:1,safety_identifier:session.subjectHash};
 const body=input.mode==='edit'?new FormData():JSON.stringify(fields);
 if (body instanceof FormData) {
  for (const [name,value] of Object.entries(fields)) body.set(name,String(value));
  body.set('image',input.photo,'startfoto.jpg');
 }
 const signal=AbortSignal.timeout(75000);
 const response=await network(API+(input.mode==='edit'?'edits':'generations'),{
  method:'POST',body,signal,redirect:'error',
  headers:{authorization:`Bearer ${env.RIG_OPENAI_IMAGES_KEY}`,...(typeof body==='string'?{'content-type':'application/json'}:{})}
 });
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
 const b64=JSON.parse(new TextDecoder().decode(bytes)).data?.[0]?.b64_json;
 if (typeof b64!=='string' || b64.length>Math.ceil(MAX_OUTPUT/3)*4) throw Error('image');
 const jpeg=Uint8Array.from(atob(b64),char=>char.charCodeAt(0));
 if (jpeg.length>MAX_OUTPUT || !isJpeg(jpeg)) throw Error('image');
 return jpeg;
}

export async function handleNativeStartPhoto(req,env,{db,session,network,now=Date.now()}) {
 const {userId}=session;
 const expiresAt=campaign(env,userId,now);
 if (req.method==='GET') {
  const available=Boolean(expiresAt);
  // Android 0.2.6 needs a value in [0,3] to show the photo controls.
  return json({enabled:available,available,remaining:available?3:0});
 }
 if (!expiresAt) return json({error:'De gesponsorde startfoto’s zijn niet beschikbaar.'},403);
 const input=await readPhotoRequest(req);
 if (!input) return json({error:'Controleer je beschrijving en foto. Kies een foto van maximaal 3 MB.'},400);
 const claimTime=Date.now();
 if (claimTime>=expiresAt) return json({error:'De gesponsorde periode is afgelopen.'},403);
 if (!await reserve(db,userId,input.requestId,claimTime))
  return json({error:'Deze aanvraag is al ingediend.'},409);
 try {
  const jpeg=await generate(input,env,session,network);
  return new Response(jpeg,{headers:{...headers,'content-type':'image/jpeg','content-length':String(jpeg.length)}});
 } catch (error) {
  // A timed-out request may have reached OpenAI. Retain the reservation and never retry automatically.
  if (error instanceof SponsorshipExhausted)
   return json({error:'Het OpenAI-tegoed voor startfoto’s is op.'},429);
  return json({error:'Je foto kon niet worden opgehaald. Je kunt het opnieuw proberen.'},502);
 }
}
