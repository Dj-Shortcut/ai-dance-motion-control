// Local-only fixture; all provider traffic is handled in-process.
import {handleProviderInput} from './rig-provider-inputs.mjs';
import {createClosedVideoService} from './closed-video-service.mjs';
import {createDurableMediaLease} from './durable-media-lease.mjs';
import encoded from './test/fixtures/silent.mp4';
const bytes=Uint8Array.from(atob(encoded),x=>x.charCodeAt(0));
export default {async fetch(req,env){
 if(env.LOCAL_FIXTURE!=='yes')return new Response(null,{status:503});
 const user=({alice:'alice',bob:'bob'})[req.headers.get('x-local-user')];
 const storedInputs=new Map();let pendingInput=null;
 const provider=async(input,init={})=>{const u=new URL(String(input));
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/upload/initiate'){pendingInput=`https://v3b.fal.media/files/b/mock/${crypto.randomUUID()}.mp4`;return Response.json({upload_url:'https://v3b.fal.media/upload/fixture',file_url:pendingInput});}
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
   if(env.RIG_O3_INLINE_INPUTS_ENABLED==='yes'&&user===env.RIG_VIDEO_OWNER_USER_ID&&u.pathname==='/fal-ai/kling-video/o3/standard/video-to-video/edit'){
    const payload=JSON.parse(init.body),headers=new Headers(init.headers);
    if(!payload.video_url.startsWith('data:video/mp4;base64,')||payload.image_urls?.length!==1||!payload.image_urls[0].startsWith('data:image/jpeg;base64,')||headers.get('x-fal-store-io')!=='0'||JSON.parse(headers.get('x-fal-object-lifecycle-preference')).initial_acl.default!=='forbid')throw Error('Invalid private inline dispatch');
   }
   const request=crypto.randomUUID();await env.DB.prepare('INSERT INTO rig_fixture_fal_dispatch(id,created_at) VALUES(?,?)').bind(request,Date.now()).run();return Response.json({request_id:request});
  }
  const m=u.pathname.match(/^\/fal-ai\/kling-video\/requests\/([0-9a-f-]{36})(\/status)?$/);
  if(u.origin==='https://queue.fal.run'&&m){if(!await env.DB.prepare('SELECT id FROM rig_fixture_fal_dispatch WHERE id=?').bind(m[1]).first())return new Response(null,{status:404});return m[2]?Response.json({request_id:m[1],status:'COMPLETED'}):Response.json({video:{url:'https://v3b.fal.media/files/b/mock/output.mp4'}})}
  if(u.href==='https://v3b.fal.media/files/b/mock/output.mp4'&&new Headers(init.headers).get('authorization')==='Bearer mock-token')return new Response(bytes,{headers:{'content-type':'video/mp4'}});
  return new Response(null,{status:404});};
 const service=await createClosedVideoService(env,{trustedUserId:user,verifyTenant:async()=>env.LOCAL_FIXTURE==='yes',lease:createDurableMediaLease(env.DB),providerFetch:provider,gatewayFetch:(url,init)=>handleProviderInput(new Request(url,init),env,{verifyTenant:async()=>env.LOCAL_FIXTURE==='yes'}),priceFetch:async()=>({currency:'USD',unit:'second',prices:{standard:0.1,pro:0.1,'edit-standard':0.14}})});return service(req);
}};
