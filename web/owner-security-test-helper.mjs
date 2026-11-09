// TEST ONLY: a real P-256 software authenticator. No browser or real passkey is
// automated, and no fixture private key is installed in the application.
import {generateKeyPairSync,createHash,randomBytes,sign} from 'node:crypto';
import {isoCBOR} from '@simplewebauthn/server/helpers';
import {handleOwnerSecurity,OWNER_ORIGIN,OWNER_RP_ID,ownerSecurityHash} from './owner-security.mjs';

const installed=new WeakMap();
const bytes=value=>new Uint8Array(Buffer.from(value,'base64url'));
const encoded=value=>Buffer.from(value).toString('base64url');
const sha=value=>createHash('sha256').update(value).digest();
const count=value=>{const output=Buffer.alloc(4);output.writeUInt32BE(value);return output;};
export function createTestAuthenticator({userHandle=encoded(Buffer.from('test-only-owner')),credentialId=encoded(randomBytes(32))}={}){
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
 const publicKey=isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,bytes(jwk.x)],[-3,bytes(jwk.y)]]));
 function clientData(type,options,{origin=OWNER_ORIGIN,challenge=options.challenge,crossOrigin=false,topOrigin}={}){
  return Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin,...(topOrigin===undefined?{}:{topOrigin})}));
 }
 function assertion(options,overrides={}){
  const data=clientData('webauthn.get',options,overrides),authenticatorData=Buffer.concat([sha(overrides.rpId??OWNER_RP_ID),Buffer.from([overrides.flags??0x05]),count(overrides.counter??0)]),signature=sign('SHA256',Buffer.concat([authenticatorData,sha(data)]),pair.privateKey);
  if(overrides.corruptSignature)signature[signature.length-1]^=1;
  return {id:credentialId,rawId:credentialId,type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON:encoded(data),authenticatorData:encoded(authenticatorData),signature:encoded(signature),userHandle:overrides.userHandle===null?null:overrides.userHandle??userHandle}};
 }
 function registration(options,overrides={}){
  const data=clientData('webauthn.create',options,overrides),credentialBytes=Buffer.from(credentialId,'base64url'),length=Buffer.alloc(2);length.writeUInt16BE(credentialBytes.length);
  const authenticatorData=Buffer.concat([sha(overrides.rpId??OWNER_RP_ID),Buffer.from([overrides.flags??0x45]),count(overrides.counter??0),Buffer.alloc(16),length,credentialBytes,publicKey]);
  const attestationObject=isoCBOR.encode(new Map([['fmt','none'],['authData',new Uint8Array(authenticatorData)],['attStmt',new Map()]]));
  return {id:credentialId,rawId:credentialId,type:'public-key',authenticatorAttachment:'platform',clientExtensionResults:{},response:{clientDataJSON:encoded(data),attestationObject:encoded(attestationObject),transports:['internal']}};
 }
 return {credentialId,publicKey,userHandle,assertion,registration};
}

export async function installTestOwnerCredential(db,ownerId,{now=Date.now()}={}){
 let owners=installed.get(db);if(!owners){owners=new Map();installed.set(db,owners);}if(owners.has(ownerId))return owners.get(ownerId);
 const authenticator=createTestAuthenticator({userHandle:encoded(Buffer.from(ownerId))}),candidateId=crypto.randomUUID(),publicKey=encoded(authenticator.publicKey),fingerprint=await ownerSecurityHash(authenticator.credentialId+'\0'+publicKey);
 await db.prepare(`INSERT INTO rig_owner_credentials(candidate_id,owner_id,credential_id,public_key,user_handle,counter,device_type,backed_up,transports_json,label,fingerprint,state,created_at,expires_at,activated_at)
  VALUES(?,?,?,?,?,0,'singleDevice',0,'["internal"]','TEST ONLY software authenticator',?,'active',?,?,?)`).bind(candidateId,ownerId,authenticator.credentialId,publicKey,authenticator.userHandle,fingerprint,now,now+31536000000,now).run();
 const value={...authenticator,candidateId,fingerprint};owners.set(ownerId,value);return value;
}

async function fixtureEnvironment(db,ownerId){
 const row=await db.prepare('SELECT * FROM rig_production_tenant WHERE id=1').first();if(!row)throw Error('Test tenant is required');
 return {PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_TESTONLY',RIG_PRODUCTION_MOLLIE_PROFILE:row.mollie_profile,RIG_PRODUCTION_ENVIRONMENT_ID:row.environment_id,RIG_PRODUCTION_SITE_ID:row.site_id,RIG_PRODUCTION_SITE_ORIGIN:row.site_origin,RIG_PRODUCTION_BRIDGE_ORIGIN:row.bridge_origin,RIG_PRODUCTION_WEBHOOK_URL:row.webhook_url,RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:ownerId};
}
export async function verificationFor(db,ownerId,operation,payload,now=Date.now(),{env}={}){
 const authenticator=await installTestOwnerCredential(db,ownerId,{now}),environment=env??await fixtureEnvironment(db,ownerId);
 const request=new Request(OWNER_ORIGIN+'/api/owner/security/verification/options',{method:'POST',headers:{origin:OWNER_ORIGIN,'content-type':'application/json'},body:JSON.stringify({operation,payload})});
 const response=await handleOwnerSecurity(request,environment,{userId:ownerId,now}),options=await response.json();
 if(!response.ok)throw Object.assign(Error('Test security options rejected: '+JSON.stringify(options)),{status:response.status});
 if(options.required===false)return null;
 return {challengeId:options.challengeId,credential:authenticator.assertion(options.publicKey)};
}
