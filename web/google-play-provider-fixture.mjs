// Ephemeral keys and mocked networks only; no Google credential or API is read.
import {playEncode,playBase64Url} from './google-play-provider-common.mjs';
export const providerNow=Date.parse('2026-11-19T12:00:00Z');
export const providerEmail='rig-push@rig-fixture.iam.gserviceaccount.com';
export const providerAudience='https://rig-api.shortcut-computerguy.workers.dev/api/google-play/rtdn';
export const providerSubscription='projects/rig-fixture/subscriptions/rig-push';
let generated;
export function providerKeys(){
 return generated??=(async()=>{
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const raw=await crypto.subtle.exportKey('pkcs8',keys.privateKey),base64=btoa(String.fromCharCode(...new Uint8Array(raw))),pem='-----BEGIN PRIVATE KEY-----\n'+base64.match(/.{1,64}/g).join('\n')+'\n-----END PRIVATE KEY-----\n';
  const jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'fixture-key',use:'sig',alg:'RS256'};delete jwk.key_ops;delete jwk.ext;
  return {keys,pem,jwk,account:{type:'service_account',client_email:providerEmail,private_key_id:'a'.repeat(40),private_key:pem,token_uri:'https://oauth2.googleapis.com/token'}};
 })();
}
export async function signedPush({claims={},header={},privateKey}={}){
 const f=await providerKeys(),h={alg:'RS256',typ:'JWT',kid:'fixture-key',...header},c={iss:'https://accounts.google.com',sub:'123456789012345678901',email:providerEmail,email_verified:true,aud:providerAudience,iat:Math.floor(providerNow/1000)-10,exp:Math.floor(providerNow/1000)+3590,...claims};
 const text=playBase64Url(playEncode(JSON.stringify(h)))+'.'+playBase64Url(playEncode(JSON.stringify(c))),sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',privateKey??f.keys.privateKey,playEncode(text));
 return 'Bearer '+text+'.'+playBase64Url(new Uint8Array(sig));
}
export function rtdnEnvelope(payload,delta={}){return {subscription:providerSubscription,message:{messageId:'message-123',data:btoa(JSON.stringify({version:'1.0',packageName:'dev.andyarijs.rig',eventTimeMillis:String(providerNow),...payload}))},...delta};}
