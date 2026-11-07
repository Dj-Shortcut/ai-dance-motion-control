// Offline test fixture. Every provider operation is handled here, in process.
import {createClosedVideoWorker} from './closed-video-worker.mjs';
import {createClosedVideoService} from './closed-video-service.mjs';
import encoded from './test/fixtures/silent.mp4';
const bytes=Uint8Array.from(atob(encoded),x=>x.charCodeAt(0));
export default {fetch(req,env){
 if(env.LOCAL_FIXTURE!=='yes')return new Response(null,{status:503});
 const storedInputs=new Map();let pendingInput=null;
 const provider=async(input,init={})=>{const u=new URL(String(input));
  await env.DB.prepare('INSERT INTO rig_fixture_trace(event) VALUES(?)').bind(`${init.method||'GET'} ${u.origin}${u.pathname}`).run();
  if((u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/upload/initiate')||(u.origin==='https://v3b.fal.media'&&u.pathname==='/upload/fixture')){
   const reserved=await env.DB.prepare("SELECT COUNT(*) n FROM rig_generation_jobs j JOIN rig_sponsored_reservations r ON r.job_id=j.id AND r.user_id=j.user_id AND r.amount_cents=j.price_cents WHERE j.state='submitting' AND j.poll_token IS NULL").first();
   if(reserved?.n!==1)throw Error('No sponsor reservation before upload');
  }
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/upload/initiate'){
   const mode=await env.DB.prepare('SELECT mode FROM rig_fixture_fal_mode WHERE id=1').first();
   if(mode?.mode==='upload-failure')return new Response(null,{status:500});
   pendingInput=`https://v3b.fal.media/files/b/mock/${crypto.randomUUID()}.mp4`;return Response.json({upload_url:'https://v3b.fal.media/upload/fixture',file_url:pendingInput});
  }
  if(u.origin==='https://v3b.fal.media'&&u.pathname==='/upload/fixture'&&init.method==='PUT'){
   if(!pendingInput||!(init.body instanceof Blob))throw Error('Invalid mock input upload');
   storedInputs.set(pendingInput,{bytes:new Uint8Array(await init.body.arrayBuffer()),mime:new Headers(init.headers).get('content-type')});
   return new Response('ok');
  }
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/files/acl')return Response.json({default:'forbid',rules:[]});
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/auth/token')return Response.json({token:'mock-token'});
  if(u.origin==='https://v3b.fal.media'&&u.pathname.endsWith('/sign'))return new Response(`${u.origin}${u.pathname.slice(0,-5)}?identity=mock`);
  if(u.origin==='https://v3b.fal.media'&&init.method==='GET'&&u.search==='?identity=mock'&&!new Headers(init.headers).has('authorization')){
   const stored=storedInputs.get(u.origin+u.pathname);if(!stored)return new Response(null,{status:404});
   return new Response(stored.bytes.slice(),{headers:{'content-type':stored.mime,'content-length':String(stored.bytes.length)}});
  }
  if(u.origin==='https://v3b.fal.media'&&init.method==='GET'&&!new Headers(init.headers).has('authorization'))return new Response(null,{status:403});
  if(u.origin==='https://queue.fal.run'&&init.method==='POST'){
   const check=await env.DB.prepare("SELECT COUNT(*) n FROM rig_generation_jobs j JOIN rig_sponsored_reservations r ON r.job_id=j.id AND r.user_id=j.user_id AND r.amount_cents=j.price_cents WHERE j.state='submitting' AND j.poll_token='dispatch-authorized'").first();
   if(check?.n!==1)throw Error('No exact sponsor dispatch reservation');
   const request=crypto.randomUUID();await env.DB.prepare('INSERT INTO rig_fixture_fal_dispatch(id) VALUES(?)').bind(request).run();
   const mode=await env.DB.prepare('SELECT mode FROM rig_fixture_fal_mode WHERE id=1').first();
   return mode?.mode==='unknown'?new Response(null,{status:500}):Response.json({request_id:request});
  }
  const m=u.pathname.match(/^\/fal-ai\/kling-video\/requests\/([0-9a-f-]{36})(\/status)?$/);
  if(u.origin==='https://queue.fal.run'&&m){
   if(!await env.DB.prepare('SELECT id FROM rig_fixture_fal_dispatch WHERE id=?').bind(m[1]).first())return new Response(null,{status:404});
   if(m[2])return Response.json({request_id:m[1],status:'COMPLETED'});
   const mode=await env.DB.prepare('SELECT mode FROM rig_fixture_fal_mode WHERE id=1').first();
   if(mode?.mode==='input-failure')return Response.json({detail:[{loc:['body'],type:'input_value_error',msg:'Failed to access the input file. Please ensure the URL is publicly accessible and in a supported format.'}]},{status:422});
   if(mode?.mode==='subject-failure')return Response.json({detail:[{loc:['body'],type:'input_value_error',msg:'Image recognition failed. Please make sure your image meets the requirements. Error: No complete upper body detected in the image; ensure the upper body is clearly visible.'}]},{status:422});
   return Response.json({video:{url:'https://v3b.fal.media/files/b/mock/output.mp4'}})
  }
  if(u.href==='https://v3b.fal.media/files/b/mock/output.mp4'&&new Headers(init.headers).get('authorization')==='Bearer mock-token')return new Response(bytes,{headers:{'content-type':'video/mp4'}});
  throw Error('Unexpected provider request');
 };
 const price=async()=>({provider:'fal',currency:'USD',unit:'second',prices:{standard:0.1,pro:0.1}});
 const effective={...env};if(req.headers.get('x-fixture-no-fal')==='1'){delete effective.FAL_KEY;delete effective.RIG_MEDIA_SECRET;delete effective.RIG_MEDIA;delete effective.BUCKET;effective.RIG_CLOSED_VIDEO_ENABLED='no'}
 return createClosedVideoWorker({pricePreflight:price,serviceFactory:(e,options)=>createClosedVideoService(e,{...options,providerFetch:provider,priceFetch:price})}).fetch(req,effective);
}};
