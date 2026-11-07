// R2 result storage: bounded streaming, private bucket only, no public object URLs.
// Ingress auth, global rate limits and bucket lifecycle remain host responsibilities.
import {isFalMedia} from './generation.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestId=/^[a-zA-Z0-9_-]{1,100}$/;
// Streaming result copies need little memory, so permit the larger files shown
// in fal's documented model examples. Unknown-size bodies use a lower bound
// because Workers must buffer them to provide R2 with a known upload length.
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
export function createResultStore(bucket,fetchImpl=fetch,streamFactory=length=>new FixedLengthStream(length)){
  if(!bucket || typeof bucket.put!=='function' || typeof bucket.get!=='function' || typeof bucket.head!=='function') throw Error('Private result storage required');
  return {
    // The caller must own the durable job and hold its unexpired poll lease.
    async store(job,url,{signal}={}){
      const key=keyFor(job);
      if(!isFalMedia(url))throw Error('Untrusted result origin');
      const old=await bounded(bucket.head(key),signal);if(old){if(!matches(old,job))throw Error('Result conflict');return key;}
      const response=await bounded(fetchImpl(url,{signal,redirect:'manual',headers:{Accept:'video/mp4'}}),signal);
      if(!response.ok)throw Error('Result unavailable');
      const length=lengthOf(response), reader=response.body.getReader();
      if(length===null){
        const chunks=[];let total=0;
        const abort=()=>{void reader.cancel().catch(()=>{});};
        if(signal?.aborted){abort();throw Error('Result timeout');}
        signal?.addEventListener('abort',abort,{once:true});
        try{
          for(;;){const {done,value}=await bounded(reader.read(),signal);if(done)break;if(!(value instanceof Uint8Array))throw Error('Invalid result');total+=value.byteLength;if(total>maxUnknownBytes)throw Error('Unknown-size result too large');chunks.push(value);}
          if(signal?.aborted||total<12)throw Error('Incomplete result');
          const data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
          if(String.fromCharCode(...data.slice(4,8))!=='ftyp')throw Error('Unsupported result format');
          const result=await bounded(bucket.put(key,data,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'video/mp4',cacheControl:'private, no-store'},customMetadata:{jobId:job.id,providerRequestId:job.falRequestId}}),signal);
          const saved=result||await bounded(bucket.head(key),signal);if(!matches(saved,job))throw Error('Result storage verification failed');return key;
        }catch(error){abort();throw error;}
        finally{signal?.removeEventListener('abort',abort);try{reader.releaseLock()}catch{}}
      }
      const fixed=streamFactory(length), writer=fixed.writable.getWriter();
      let total=0, prefix=new Uint8Array(0), checked=false, written=0;
      let putPromise;
      const abort=()=>{void reader.cancel().catch(()=>{});void writer.abort().catch(()=>{});};
      if(signal?.aborted){abort();throw Error('Result timeout');}
      signal?.addEventListener('abort',abort,{once:true});
      try {
        // R2 requires a FixedLengthStream; pipe with backpressure. Read no more
        // than the first eight bytes before checking the ISO MP4 signature.
        while(!checked){
          const {done,value}=await bounded(reader.read(),signal);if(done)throw Error('Incomplete result');
          total+=value.byteLength;if(total>length || total>maxBytes)throw Error('Result too large');
          const needed=8-prefix.length, first=value.subarray(0,needed);
          const p=new Uint8Array(prefix.length+first.length);p.set(prefix);p.set(first,prefix.length);prefix=p;
          if(prefix.length<8)continue;
          if(String.fromCharCode(...prefix.slice(4,8))!=='ftyp')throw Error('Unsupported result format');
          checked=true;
          putPromise=Promise.resolve(bucket.put(key,fixed.readable,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'video/mp4',cacheControl:'private, no-store'},customMetadata:{jobId:job.id,providerRequestId:job.falRequestId}}));
          // A competing immutable write may return null without consuming the stream.
          // Stop our writer immediately; the caller can safely retry.
          putPromise.then(result=>{if(!result)abort();},abort);
          await bounded(writer.write(prefix),signal);written+=prefix.byteLength;
          const remainder=value.subarray(first.byteLength);if(remainder.byteLength){await bounded(writer.write(remainder),signal);written+=remainder.byteLength;}
        }
        for(;;){const {done,value}=await bounded(reader.read(),signal);if(done)break;total+=value.byteLength;if(total>length || total>maxBytes)throw Error('Result too large');await bounded(writer.write(value),signal);written+=value.byteLength;}
        if(signal?.aborted || total!==length || written!==length)throw Error('Incomplete result');
        await bounded(writer.close(),signal);
        const result=await bounded(putPromise,signal), saved=result || await bounded(bucket.head(key),signal);
        if(!matches(saved,job))throw Error('Result storage verification failed');
        return key;
      }catch(error){abort();throw error;}
      finally{signal?.removeEventListener('abort',abort);}
    },
    // Call only after checking current ownership and state in durable storage.
    async read(job){
      const key=keyFor(job);if(job.state!=='completed' || job.resultKey!==key)throw Error('Result unavailable');
      const object=await bucket.get(key);if(!matches(object,job) || !object.body)throw Error('Result unavailable');
      return new Response(object.body,{status:200,headers:{'Content-Type':'video/mp4','Content-Length':String(object.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline; filename="RIG-result.mp4"'}});
    }
  };
}
