// R2 result storage: bounded streaming, private bucket only, no public object URLs.
// Ingress auth, global rate limits and bucket lifecycle remain host responsibilities.
import {isFalMedia} from './generation.mjs';
import {inspectResultMp4} from './result-mp4-inspect.mjs';
import {TEMPORARY_LINK_POLICY} from './upload.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestId=/^[a-zA-Z0-9_-]{1,100}$/;
// Hold a bounded result in memory until structural inspection succeeds.
// Unknown-size responses use a lower cap to bound buffering overhead.
const maxBytes=64*1024*1024;
const maxUnknownBytes=16*1024*1024;
function keyFor(job){if(!job || !uuid.test(job.id) || !requestId.test(job.falRequestId)) throw Error('Invalid result identity');return `rig-results/${job.id}.mp4`;}
function matches(obj,job){return obj && obj.customMetadata?.jobId===job.id && obj.customMetadata?.providerRequestId===job.falRequestId && obj.httpMetadata?.contentType==='video/mp4' && Number.isSafeInteger(obj.size) && obj.size>=12 && obj.size<=maxBytes;}
function lengthOf(response){const declared=response.headers.get('content-length');if(!response.body)throw Error('Missing result');if(declared===null)return null;if(!/^\d+$/.test(declared) || Number(declared)<12 || Number(declared)>maxBytes)throw Error('Unsupported result size');return Number(declared);}
function bounded(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(Error('Result timeout'));
  return new Promise((resolve,reject)=>{const onAbort=()=>{signal.removeEventListener('abort',onAbort);reject(Error('Result timeout'));};signal.addEventListener('abort',onAbort,{once:true});Promise.resolve(promise).then(v=>{signal.removeEventListener('abort',onAbort);resolve(v);},e=>{signal.removeEventListener('abort',onAbort);reject(e);});});
}
export function createResultStore(bucket,fetchImpl=fetch){
  if(!bucket || typeof bucket.put!=='function' || typeof bucket.get!=='function' || typeof bucket.head!=='function') throw Error('Private result storage required');
  return {
    // The caller must own the durable job and hold its unexpired poll lease.
    async store(job,url,{signal,transferPolicy}={}){
      const key=keyFor(job);
      if(transferPolicy!==undefined&&transferPolicy!==TEMPORARY_LINK_POLICY)throw Error('Unsupported transfer policy');
      if(!isFalMedia(url))throw Error('Untrusted result origin');
      const old=await bounded(bucket.head(key),signal);
      if(old){if(!matches(old,job)||old.customMetadata?.inspection!=='result-mp4-v1')throw Error('Result conflict or unverified legacy result');return key;}
      const response=await bounded(fetchImpl(url,{signal,redirect:'manual',headers:{Accept:'video/mp4'},...(transferPolicy===TEMPORARY_LINK_POLICY?{transferPolicy}:{})}),signal);
      if(!response.ok)throw Error('Result unavailable');
      const length=lengthOf(response),reader=response.body.getReader(),limit=length??maxUnknownBytes;
      // A known-size response uses one bounded allocation. Unknown-size output
      // is capped more tightly; no object is written until validation succeeds.
      let data=length===null?null:new Uint8Array(length),chunks=[],total=0;
      const abort=()=>{void reader.cancel().catch(()=>{});};
      if(signal?.aborted){abort();throw Error('Result timeout');}
      signal?.addEventListener('abort',abort,{once:true});
      try{
        for(;;){const {done,value}=await bounded(reader.read(),signal);if(done)break;if(!(value instanceof Uint8Array))throw Error('Invalid result');
          if(total+value.byteLength>limit)throw Error('Result too large');
          if(data)data.set(value,total);else chunks.push(value);
          total+=value.byteLength;
        }
        if(signal?.aborted||total<12||length!==null&&total!==length)throw Error('Incomplete result');
        if(!data){data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length}chunks=[];}
        inspectResultMp4(data);
        const result=await bounded(bucket.put(key,data,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'video/mp4',cacheControl:'private, no-store'},customMetadata:{jobId:job.id,providerRequestId:job.falRequestId,inspection:'result-mp4-v1'}}),signal);
        const saved=result||await bounded(bucket.head(key),signal);
        if(!matches(saved,job)||saved.customMetadata?.inspection!=='result-mp4-v1')throw Error('Result storage verification failed');
        return key;
      }catch(error){abort();throw error;}
      finally{signal?.removeEventListener('abort',abort);try{reader.releaseLock()}catch{}}

    },
    // Call only after checking current ownership and state in durable storage.
    async read(job){
      const key=keyFor(job);if(job.state!=='completed' || job.resultKey!==key)throw Error('Result unavailable');
      const object=await bucket.get(key);if(!matches(object,job) || !object.body)throw Error('Result unavailable');
      return new Response(object.body,{status:200,headers:{'Content-Type':'video/mp4','Content-Length':String(object.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline; filename="RIG-result.mp4"'}});
    }
  };
}
