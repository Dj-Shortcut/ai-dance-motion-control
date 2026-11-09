// Server-only encoding of already owned, digest-verified media. Never accept a
// client data URI or expose an encoded input through a browser/tool response.
export const INLINE_REQUEST_MAX_BYTES=6*1024*1024;
export const INLINE_IMAGE_MAX_BYTES=1024*1024;
export const INLINE_VIDEO_MAX_BYTES=3*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const MIME={image:'image/jpeg',video:'video/mp4'};
const limit=kind=>kind==='image'?INLINE_IMAGE_MAX_BYTES:kind==='video'?INLINE_VIDEO_MAX_BYTES:0;
function magic(bytes,kind){
 if(kind==='image')return bytes.length>=16&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217;
 if(kind==='video'){
  if(bytes.length<32||bytes[4]!==102||bytes[5]!==116||bytes[6]!==121||bytes[7]!==112)return false;
  const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
  return size>=16&&size<=bytes.length;
 }
 return false;
}
function base64(bytes){
 const parts=[];
 // A multiple of three makes concatenated chunks canonical without any
 // intermediate padding; bounded spreads avoid a large-file stack overflow.
 for(let i=0;i<bytes.length;i+=24576)parts.push(btoa(String.fromCharCode(...bytes.subarray(i,i+24576))));
 return parts.join('');
}
export function encodeInlineInput({bytes,kind}={}){
 if(!(bytes instanceof Uint8Array)||!limit(kind)||bytes.length>limit(kind)||!magic(bytes,kind))throw Error('Inline media unavailable');
 return `data:${MIME[kind]};base64,${base64(bytes)}`;
}
export async function validateInlineInput(asset,{kind,sha256}={}){
 try{
  const max=limit(kind),prefix=`data:${MIME[kind]};base64,`;
  if(!max||asset?.inline!==true||asset.verified!==true||asset.kind!==kind||!UUID.test(asset.id??'')||!SHA.test(sha256??'')||asset.sha256!==sha256||!Number.isSafeInteger(asset.size)||asset.size<16||asset.size>max||typeof asset.url!=='string'||!asset.url.startsWith(prefix)||asset.url.length!==prefix.length+4*Math.ceil(asset.size/3))return false;
  const encoded=asset.url.slice(prefix.length);
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))return false;
  const binary=atob(encoded);if(binary.length!==asset.size)return false;
  const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  if(!magic(bytes,kind)||base64(bytes)!==encoded)return false;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  return digest===sha256;
 }catch{return false;}
}
