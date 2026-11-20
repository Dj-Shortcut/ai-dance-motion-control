// LOCAL TEST ONLY. Uses the actual consent HTML and CSP with inert identity.
// Browser operation belongs to CUA; this server only records Origin/status.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {handleNativeSiteLogin} from './native-sites-login.mjs';
import {nativePkceChallenge} from './native-auth.mjs';
const code='c'.repeat(43),state='s'.repeat(43);
const readBytes=async(stream,max)=>{const bytes=new Uint8Array(await new Response(stream).arrayBuffer());if(bytes.length>max)throw Error('body too large');return bytes;};
const context=async()=>({session:{mode:'live'},request:async()=>Response.json({code,expiresAt:Date.now()+300000},{status:201})});
export async function nativeOriginFixtureResponse(req,{origin,observations=[]}={}){
 const url=new URL(req.url);if(url.origin!==origin)return new Response(null,{status:403});
 if(req.method==='GET'&&['/broken','/fixed'].includes(url.pathname)){
  const query='?challenge='+await nativePkceChallenge('v'.repeat(43))+'&state='+state;
  const response=await handleNativeSiteLogin(new Request(origin+'/native/signin'+query),{}, {context,readBytes});
  const headers=new Headers(response.headers);headers.set('referrer-policy',url.pathname==='/broken'?'no-referrer':'same-origin');
  return new Response(response.body,{status:response.status,headers});
 }
 if(req.method==='GET'&&url.pathname==='/observations')return Response.json({observations},{headers:{'cache-control':'no-store'}});
 if(req.method==='POST'&&url.pathname==='/native/authorize'){
  const response=await handleNativeSiteLogin(req,{}, {context,readBytes});
  // Never record form fields, challenge, state, code, cookies or identity.
  observations.push({origin:req.headers.get('origin'),secFetchSite:req.headers.get('sec-fetch-site'),status:response.status});
  if(observations.length>20)observations.shift();
  return response;
 }
 return new Response(null,{status:404});
}
export async function startNativeOriginFixture(){
 const observations=[];let origin;
 const server=createServer(async(incoming,outgoing)=>{
  try{
   const headers=new Headers();for(const [name,value]of Object.entries(incoming.headers))if(typeof value==='string')headers.set(name,value);
   let body;if(incoming.method==='POST'){const parts=[];let size=0;for await(const chunk of incoming){size+=chunk.length;if(size>1024){outgoing.writeHead(413);outgoing.end();return;}parts.push(chunk);}body=Buffer.concat(parts);}
   const request=new Request(origin+incoming.url,{method:incoming.method,headers,...(body?{body}:{})});
   const response=await nativeOriginFixtureResponse(request,{origin,observations});
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch{outgoing.writeHead(500,{'content-type':'text/plain'});outgoing.end('Local fixture could not handle this request.');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 return {origin,observations,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const fixture=await startNativeOriginFixture();process.stdout.write(JSON.stringify({broken:fixture.origin+'/broken',fixed:fixture.origin+'/fixed',observations:fixture.origin+'/observations',externalServices:false})+'\n');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await fixture.close();process.exit(0);});
}
