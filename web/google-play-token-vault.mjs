import {GOOGLE_PLAY_PACKAGE} from './google-play-purchases.mjs';
import {playProviderError as fail,playObject,playTokenValid,playHexValid,playFromBase64Url,playBase64Url,playEncode,playSha256} from './google-play-provider-common.mjs';
const prefix='rig-play-token-v1',validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(value);
export function createGooglePlayTokenVault(options={}){
 if(options.enabled!==true)return Object.freeze({enabled:false,async seal(){throw fail('play_vault_setup')},async open(){throw fail('play_vault_setup')}});
 let {currentKeyId,keys}=options;
 if(typeof keys==='string'){if(keys.length>4096)throw fail('play_vault_setup');try{keys=JSON.parse(keys)}catch{throw fail('play_vault_setup')}}
 if(!validId(currentKeyId)||!playObject(keys)||Object.keys(keys).length<1||Object.keys(keys).length>8||!Object.hasOwn(keys,currentKeyId))throw fail('play_vault_setup');
 const ring=new Map();
 for(const [id,encoded]of Object.entries(keys)){
  if(!validId(id))throw fail('play_vault_setup');let bytes;
  try{bytes=playFromBase64Url(encoded,32)}catch{throw fail('play_vault_setup')}
  if(bytes.length!==32)throw fail('play_vault_setup');
  ring.set(id,crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']));
 }
 const bound=(tokenHash,mode,keyId)=>{if(!playHexValid(tokenHash)||!['test','live'].includes(mode))throw fail('play_vault_binding');return playEncode(JSON.stringify([prefix,GOOGLE_PLAY_PACKAGE,mode,tokenHash,keyId]));};
 async function seal({purchaseToken,tokenHash,mode}={}){
  const aad=bound(tokenHash,mode,currentKeyId);if(!playTokenValid(purchaseToken)||await playSha256(purchaseToken)!==tokenHash)throw fail('play_vault_binding');
  try{const iv=crypto.getRandomValues(new Uint8Array(12)),key=await ring.get(currentKeyId);const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},key,playEncode(purchaseToken));return [prefix,currentKeyId,playBase64Url(iv),playBase64Url(new Uint8Array(encrypted))].join('.');}
  catch{throw fail('play_vault_seal');}
 }
 async function open({sealedToken,tokenHash,mode}={}){
  if(typeof sealedToken!=='string'||sealedToken.length>8192)throw fail('play_vault_open');
  const parts=sealedToken.split('.');if(parts.length!==4||parts[0]!==prefix||!validId(parts[1])||!ring.has(parts[1]))throw fail('play_vault_open');
  const aad=bound(tokenHash,mode,parts[1]);
  try{
   const iv=playFromBase64Url(parts[2],12),encrypted=playFromBase64Url(parts[3],4112);if(iv.length!==12||encrypted.length<24)throw Error();
   const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},await ring.get(parts[1]),encrypted),token=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   if(!playTokenValid(token)||await playSha256(token)!==tokenHash)throw Error();return token;
  }catch{throw fail('play_vault_open');}
 }
 return Object.freeze({enabled:true,seal,open});
}
