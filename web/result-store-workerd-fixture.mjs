// Local-only fake provider; exercises real workerd FixedLengthStream and R2 binding.
import {createResultStore} from './results.mjs';
const bytes=new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,1,2,3,4,5,6,7,8]);
const job={id:'123e4567-e89b-42d3-a456-426614174000',falRequestId:'request_123',state:'completed',resultKey:'rig-results/123e4567-e89b-42d3-a456-426614174000.mp4'};
export default {async fetch(req,env){
 const unknown=new URL(req.url).pathname==='/unknown';
 const testJob=unknown?{...job,id:'123e4567-e89b-42d3-a456-426614174001',resultKey:'rig-results/123e4567-e89b-42d3-a456-426614174001.mp4'}:job;
 const store=createResultStore(env.BUCKET,async(_url,opts)=>{if(opts.redirect!=='manual')throw Error();if(unknown)return new Response(new ReadableStream({start(c){c.enqueue(bytes);c.close()}}));return new Response(bytes,{headers:{'content-length':String(bytes.length)}})});
 const key=await store.store(testJob,'https://v3b.fal.media/files/b/test/result.mp4');
 if(key!==testJob.resultKey)throw Error('bad key');
 return store.read(testJob);
}};
