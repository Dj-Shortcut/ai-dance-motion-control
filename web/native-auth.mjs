// Native access is issued only from a signed, already-authenticated Sites user.
// PKCE protects interception of the fixed app callback. No refresh token, role,
// bridge secret, provider credential or raw platform subject reaches the app.
import {sitesDigest} from './sites-bridge-protocol.mjs';
export const NATIVE_CODE_TTL=300000;
export const NATIVE_SESSION_TTL=30*24*60*60*1000;
export const NATIVE_CALLBACK='dev.andyarijs.rig://auth/callback';
const SITE='appgprj_6aeec13b50448191b88da670dac8aa98';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const B64=/^[A-Za-z0-9_-]{43}$/;
const TOKEN=/^rig_native_[A-Za-z0-9_-]{43}$/;
const VERIFIER=/^[A-Za-z0-9._~-]{43,128}$/;
const encode=value=>new TextEncoder().encode(value);
const b64=value=>btoa(String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const exact=(data,keys)=>data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===keys.length&&keys.every(key=>Object.hasOwn(data,key));
const equal=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
export const validNativeChallenge=value=>typeof value==='string'&&B64.test(value);
export const nativePkceChallenge=async verifier=>b64(new Uint8Array(await crypto.subtle.digest('SHA-256',encode(verifier))));
const hash=async value=>sitesDigest(encode(value));
const identity=`EXISTS(SELECT 1 FROM rig_sites_identities i WHERE i.site_id=n.site_id AND i.subject_hash=n.subject_hash AND i.user_id=n.user_id)`;

export async function issueNativeAuthorization(db,{siteId,subjectHash,userId,challenge,now=Date.now()}={}){
 if(siteId!==SITE||!HASH.test(subjectHash||'')||!USER.test(userId||'')||!validNativeChallenge(challenge)||!Number.isSafeInteger(now)||now<0)return null;
 const code=random(),codeHash=await hash(code),expiresAt=now+NATIVE_CODE_TTL;
 // Limit active authorizations even if the upstream rate limiter is unavailable.
 const result=await db.prepare(`INSERT INTO rig_native_login_codes(code_hash,site_id,subject_hash,user_id,challenge,created_at,expires_at)
  SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_sites_identities WHERE site_id=? AND subject_hash=? AND user_id=?)
  AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
  AND (SELECT COUNT(*) FROM rig_native_login_codes WHERE user_id=? AND expires_at>? AND consumed_at IS NULL)<5`)
  .bind(codeHash,siteId,subjectHash,userId,challenge,now,expiresAt,siteId,subjectHash,userId,userId,now).run();
 return result.meta?.changes===1?{code,expiresAt}:null;
}

export async function exchangeNativeAuthorization(db,data,{now=Date.now()}={}){
 if(!exact(data,['code','codeVerifier'])||typeof data.code!=='string'||typeof data.codeVerifier!=='string'||!B64.test(data.code)||!VERIFIER.test(data.codeVerifier)||!Number.isSafeInteger(now)||now<0)return null;
 const codeHash=await hash(data.code),row=await db.prepare(`SELECT n.* FROM rig_native_login_codes n WHERE n.code_hash=? AND n.consumed_at IS NULL AND n.expires_at>? AND ${identity}`).bind(codeHash,now).first();
 if(!row||row.site_id!==SITE||!USER.test(row.user_id)||!equal(await nativePkceChallenge(data.codeVerifier),row.challenge))return null;
 const accessToken='rig_native_'+random(),tokenHash=await hash(accessToken),expiresAt=now+NATIVE_SESSION_TTL;
 // The unique token hash owns the claim; a timestamp alone is not a race fence.
 const claim=db.prepare(`UPDATE rig_native_login_codes SET consumed_at=?,consumed_token_hash=? WHERE code_hash=? AND consumed_at IS NULL AND expires_at>? AND challenge=?
  AND EXISTS(SELECT 1 FROM rig_sites_identities i WHERE i.site_id=rig_native_login_codes.site_id AND i.subject_hash=rig_native_login_codes.subject_hash AND i.user_id=rig_native_login_codes.user_id)`)
  .bind(now,tokenHash,codeHash,now,row.challenge);
 const install=db.prepare(`INSERT INTO rig_native_sessions(token_hash,site_id,subject_hash,user_id,created_at,expires_at)
  SELECT ?,site_id,subject_hash,user_id,?,? FROM rig_native_login_codes WHERE code_hash=? AND consumed_token_hash=? AND consumed_at=?
  AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')`).bind(tokenHash,now,expiresAt,codeHash,tokenHash,now);
 const assert=db.prepare('INSERT INTO rig_native_auth_assertions(value) SELECT CASE WHEN EXISTS(SELECT 1 FROM rig_native_sessions WHERE token_hash=? AND user_id=?) THEN 1 ELSE 0 END').bind(tokenHash,row.user_id);
 try{const result=await db.batch([claim,install,assert]);if(result[1].meta?.changes!==1)return null;}catch{return null;}
 return {accessToken,tokenType:'Bearer',expiresAt,userId:row.user_id,currency:'EUR',mode:'live'};
}

export async function authenticateNativeSession(db,authorization,{now=Date.now()}={}){
 if(typeof authorization!=='string'||!authorization.startsWith('Bearer ')||!TOKEN.test(authorization.slice(7))||!Number.isSafeInteger(now)||now<0)return null;
 const tokenHash=await hash(authorization.slice(7)),row=await db.prepare(`SELECT n.* FROM rig_native_sessions n WHERE n.token_hash=? AND n.revoked_at IS NULL AND n.expires_at>? AND ${identity}
  AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')`).bind(tokenHash,now).first();
 return row?.site_id===SITE&&USER.test(row.user_id)&&HASH.test(row.subject_hash)?{userId:row.user_id,siteId:row.site_id,subjectHash:row.subject_hash,tokenHash,expiresAt:row.expires_at}:null;
}
export async function revokeNativeSession(db,session,{now=Date.now()}={}){
 if(!HASH.test(session?.tokenHash||'')||!USER.test(session?.userId||''))return false;
 return (await db.prepare('UPDATE rig_native_sessions SET revoked_at=? WHERE token_hash=? AND user_id=? AND revoked_at IS NULL').bind(now,session.tokenHash,session.userId).run()).meta?.changes===1;
}
