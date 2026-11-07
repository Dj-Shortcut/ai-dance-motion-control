import encoded from './trial-fixtures/synthetic.mp4';
// Isolated fal stand-in, bound directly as a private workerd service only.
export default {async fetch(req,env){
 const u=new URL(req.url);
 if(env.LOCAL_FIXTURE!=='yes'||!env.DB||req.headers.get('authorization')!=='Key local-fake-not-a-key')return new Response(null,{status:403});
 if(u.origin==='https://queue.fal.run'&&req.method==='POST'&&/^\/fal-ai\/kling-video\/v3\/(?:standard|pro)\/motion-control$/.test(u.pathname)){
  const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO rig_fixture_fal_dispatch(id,created_at) VALUES (?,?)').bind(id,Date.now()).run();
  return Response.json({request_id:id});
 }
 const match=u.pathname.match(/^\/fal-ai\/kling-video\/requests\/([0-9a-f-]{36})(\/status)?$/);
 if(u.origin==='https://queue.fal.run'&&req.method==='GET'&&match){
  if(!await env.DB.prepare('SELECT id FROM rig_fixture_fal_dispatch WHERE id=?').bind(match[1]).first())return new Response(null,{status:404});
  return match[2]?Response.json({request_id:match[1],status:'COMPLETED'}):Response.json({video:{url:'https://v3b.fal.media/files/b/mock/output.mp4'}});
 }
 if(u.href==='https://v3b.fal.media/files/b/mock/output.mp4'&&req.method==='GET')return new Response(Uint8Array.from(atob(encoded),x=>x.charCodeAt(0)),{headers:{'content-type':'video/mp4'}});
 return new Response(null,{status:404});
}};
