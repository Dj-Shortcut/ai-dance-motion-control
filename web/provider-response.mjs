// Bound untrusted provider metadata independently of Content-Length and cancel
// stalled readers on the same deadline as the request. Error bodies remain
// forbidden except caller-explicit 422 validation or 403 billing rejection
// checks. Neither status alone proves a safe refund.
export async function providerText(response,{signal,limit=65536,acceptedStatus}={}){
 if((!response.ok && !([403,422].includes(acceptedStatus) && response.status===acceptedStatus)) || !response.body)throw Error('Provider unavailable');
 const declared=response.headers.get('content-length');
 if(declared!==null && (!/^\d+$/.test(declared)||Number(declared)>limit)){
  void response.body.cancel().catch(()=>{});throw Error('Provider response too large');
 }
 const reader=response.body.getReader(),chunks=[];let length=0;
 const abort=()=>{void reader.cancel().catch(()=>{})};
 let onAbort;
 const checkDeadline=()=>{if(signal?.aborted)throw Error('Provider timeout')};
 try{
  checkDeadline();
  const deadline=signal && new Promise((_,reject)=>{
   onAbort=()=>reject(Error('Provider timeout'));
   signal.addEventListener('abort',onAbort,{once:true});
  });
  for(;;){
   const read=reader.read();const {done,value}=await (deadline?Promise.race([read,deadline]):read);
   checkDeadline();
   if(done)break;
   if(!(value instanceof Uint8Array))throw Error('Invalid provider response');
   length+=value.byteLength;if(length>limit)throw Error('Provider response too large');chunks.push(value);
  }
  checkDeadline();
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  checkDeadline();
  return text;
 }catch(error){abort();throw error}finally{if(onAbort)signal.removeEventListener('abort',onAbort);try{reader.releaseLock()}catch{}}
}
export async function providerJSON(response,options){return JSON.parse(await providerText(response,options))}

const billingRejections=new WeakSet(),ID=/^[A-Za-z0-9_-]{1,100}$/;
// Fal rejects locked accounts before accepting a queue request (FAQ), and the
// precise 403 JSON below is recorded in fal-ai/fal#1147, resolved by Fal staff.
// https://fal.ai/docs/documentation/model-apis/faq
// https://github.com/fal-ai/fal/issues/1147
// A generic 402, 403, timeout, prose match or accepted request ID is NOT proof.
// Caller must use the direct response to its fixed authenticated queue POST.
export async function providerBillingRejection(response,{signal,userId,jobId}={}){
 if(!ID.test(userId||'')||!ID.test(jobId||'')||response.status!==403||response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))return null;
 let text,data;try{text=await providerText(response,{signal,acceptedStatus:403,limit:2048});data=JSON.parse(text);}catch{return null;}
 const length=response.headers.get('content-length');if(length!==null&&Number(length)!==new TextEncoder().encode(text).length)return null;
 if(!data||Array.isArray(data)||typeof data!=='object'||Object.keys(data).length!==1||data.detail!=='User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing')return null;
 const proof=Object.freeze({code:'provider_billing_locked',userId,jobId});billingRejections.add(proof);return proof;
}
export function isProviderBillingRejection(proof,{userId,jobId}={}){return Boolean(proof&&billingRejections.has(proof)&&proof.userId===userId&&proof.jobId===jobId);}

// Only the two exact observed fal validation rejections are classified terminal.
// The caller must first verify COMPLETED and matching request_id from the fixed
// authenticated status URL and fetch this body from that same job's result URL.
export async function providerInputValidation(response,{signal,requestId,allowInlineEcho=false}={}){
 if(response.status!==422 || !/^(?:application\/json|application\/problem\+json)(?:\s*;|$)/i.test(response.headers.get('content-type')||'') || typeof requestId!=='string')return false;
 // Some validation responses echo the submitted inline file bytes. Only the
 // exact owned, bounded inline job may read that larger error; it is never
 // logged, stored or returned. Ordinary metadata retains the 64 KiB limit.
 let data;try{data=JSON.parse(await providerText(response,{signal,acceptedStatus:422,limit:allowInlineEcho===true?8*1024*1024:65536}));}catch{return false;}
 if(!data || typeof data!=='object' || Array.isArray(data) || data.request_id!==undefined && data.request_id!==requestId)return false;
 const detail=data.detail;
 if(!Array.isArray(detail) || detail.length!==1)return false;
 const d=detail[0];
 if(!d || typeof d!=='object' || Array.isArray(d) || d.type!=='input_value_error' || !Array.isArray(d.loc) || d.loc.length!==1 || d.loc[0]!=='body')return false;
 if(d.msg==='Failed to access the input file. Please ensure the URL is publicly accessible and in a supported format.')return 'provider_input_unavailable';
 if(d.msg==='Image recognition failed. Please make sure your image meets the requirements. Error: No complete upper body detected in the image; ensure the upper body is clearly visible.')return 'provider_subject_not_detected';
 return false;
}
