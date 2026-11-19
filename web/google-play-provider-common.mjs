export const playProviderError=code=>Object.assign(Error('Google Play kon niet veilig worden gecontroleerd.'),{code});
export const playObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const playTokenValid=value=>typeof value==='string'&&value.length>=8&&value.length<=4096&&!/[^\x21-\x7e]/.test(value);
export const playHexValid=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const playEncode=value=>new TextEncoder().encode(value);
export function playBase64Url(bytes){let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function playFromBase64Url(value,max=16384){
 if(typeof value!=='string'||!value.length||value.length>Math.ceil(max*4/3)||!/^[A-Za-z0-9_-]+$/.test(value)||value.length%4===1)throw playProviderError('play_encoding');
 let bytes;try{bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),char=>char.charCodeAt(0));}catch{throw playProviderError('play_encoding');}
 if(bytes.length>max||playBase64Url(bytes)!==value)throw playProviderError('play_encoding');return bytes;
}
export async function playSha256(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',playEncode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
export async function playReadJson(response,{max=32768,timeout=15000,status=200}={}){
 if(!response||response.status!==status||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||''))throw playProviderError('play_provider_response');
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))throw playProviderError('play_provider_response');
 const reader=response.body?.getReader();if(!reader)throw playProviderError('play_provider_response');let timer,size=0;const chunks=[];
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(playProviderError('play_provider_timeout')),timeout)});
 try{
  for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;if(!(part.value instanceof Uint8Array)||(size+=part.value.byteLength)>max)throw playProviderError('play_provider_response');chunks.push(part.value);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!playObject(result))throw playProviderError('play_provider_response');return result;
 }catch{throw playProviderError('play_provider_response');}
 finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{})}catch{}}
}
