// The Site owns sign-in and the session cookie. This adapter never accepts an
// identity or token from a URL, browser storage, or a tool argument.
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createNativeSiteAuth({browser,fetchImpl=fetch}={}){
 let origin;try{origin=new URL(browser.location.href).origin}catch{throw Error('Ongeldige RIG-pagina.');}
 if(!origin.startsWith('https://')||typeof fetchImpl!=='function')throw Error('Ongeldige RIG-pagina.');
 const listeners=new Set();let observed,reading=null,disposed=false,timer=null;
 const ended=()=>Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');
 function publish(userId){if(observed===userId)return;observed=userId;for(const listener of [...listeners])listener(userId);}
 async function snapshot(){
  if(disposed)throw ended();
  if(reading)return reading;
  const pending=(async()=>{
   const response=await fetchImpl(origin+'/api/session',{method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});
   if(disposed)throw ended();
   if([401,403].includes(response.status)){publish(null);return {userId:null};}
   if(!response.ok||!response.body)throw Error('Aanmelding kon niet worden gecontroleerd.');
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048)throw Error('Ongeldige aanmelding.');chunks.push(value);}}
   finally{try{void reader.cancel().catch(()=>{})}catch{}}
   const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
   let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('Aanmelding kon niet worden gecontroleerd.');}
   if(!USER.test(value?.userId||'')||disposed)throw ended();
   publish(value.userId);return {userId:value.userId};
  })();
  reading=pending;try{return await pending}finally{if(reading===pending)reading=null;}
 }
 async function sessionSubject(){return (await snapshot()).userId;}
 async function currentSession(){return Boolean(await sessionSubject());}
 const refresh=()=>{if(!disposed)void snapshot().catch(()=>publish(null));};
 const visible=()=>{if(browser.document?.visibilityState==='visible')refresh();};
 function watchSession(listener){
  if(disposed||typeof listener!=='function')throw ended();
  if(!listeners.size){browser.addEventListener?.('focus',refresh);browser.addEventListener?.('pageshow',refresh);browser.document?.addEventListener('visibilitychange',visible);timer=browser.setInterval?.(refresh,30000);timer?.unref?.();}
  listeners.add(listener);
  return ()=>{listeners.delete(listener);if(!listeners.size)stopWatching();};
 }
 function stopWatching(){browser.removeEventListener?.('focus',refresh);browser.removeEventListener?.('pageshow',refresh);browser.document?.removeEventListener('visibilitychange',visible);if(timer!==null)browser.clearInterval?.(timer);timer=null;}
 async function api(path,options={},expectedUserId=null){
  if(disposed)throw ended();
  let target;try{target=new URL(path,origin)}catch{throw Error('Ongeldige aanvraag.');}
  const method=(options.method||'GET').toUpperCase();
  if(typeof path!=='string'||path.length>1200||!path.startsWith('/api/')||target.pathname+target.search!==path||!target.pathname.startsWith('/api/')||target.origin!==origin||target.username||target.password||target.hash||target.pathname==='/api/payments/webhook'||!['GET','POST'].includes(method))throw Error('Ongeldige aanvraag.');
  if(expectedUserId!==null&&!USER.test(expectedUserId))throw ended();
  const before=await snapshot();
  if(expectedUserId!==null&&before.userId!==expectedUserId)throw ended();
  if(target.pathname==='/api/session'&&!target.search&&method==='GET')return Response.json(before.userId?{userId:before.userId}:{error:'Aanmelden vereist.'},{status:before.userId?200:401});
  if(!before.userId)throw ended();
  const bound=expectedUserId??before.userId,headers=new Headers(options.headers);
  headers.delete('authorization');headers.delete('cookie');headers.set('x-rig-expected-user',bound);
  const response=await fetchImpl(target.href,{...options,method,headers,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
  try{if(disposed||(await snapshot()).userId!==bound||options.signal?.aborted)throw ended();}
  catch(error){if(response.body)void response.body.cancel().catch(()=>{});throw error;}
  return response;
 }
 function dispose(){if(disposed)return;disposed=true;stopWatching();listeners.clear();}
 return Object.freeze({api,sessionSubject,currentSession,watchSession,dispose});
}
