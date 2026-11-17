// TEST ONLY: real software-authenticator signatures and isolated fixture rows.
// Never imported by a production entrypoint; no real user key is automated.
import {createTestAuthenticator} from './owner-security-test-helper.mjs';
import {CUSTOMER_ORIGIN,handleCustomerSecurity,customerSecurityHash} from './customer-security.mjs';
import {RECAST_MODEL} from './recast-contract.mjs';

const installed=new WeakMap(),encoded=value=>Buffer.from(value).toString('base64url');
export async function installTestCustomerCredential(db,userId,{now=Date.now()}={}){
 let users=installed.get(db);if(!users){users=new Map();installed.set(db,users);}if(users.has(userId))return users.get(userId);
 const tenant=await db.prepare('SELECT * FROM rig_production_tenant WHERE id=1').first();if(!tenant)throw Error('Test tenant is required');
 await db.prepare('INSERT OR IGNORE INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind(tenant.site_id,await customerSecurityHash('TEST ONLY customer:'+userId),userId,now).run();
 const authenticator=createTestAuthenticator({userHandle:encoded(userId)}),publicKey=encoded(authenticator.publicKey),fingerprint=await customerSecurityHash(authenticator.credentialId+'\0'+publicKey);
 await db.prepare(`INSERT INTO rig_customer_credentials(credential_id,user_id,public_key,user_handle,counter,device_type,backed_up,transports_json,label,fingerprint,state,created_at,activated_at)
  VALUES(?,?,?,?,0,'singleDevice',0,'["internal"]','TEST ONLY software authenticator',?,'active',?,?)`).bind(authenticator.credentialId,userId,publicKey,authenticator.userHandle,fingerprint,now,now).run();
 const value={...authenticator,fingerprint};users.set(userId,value);return value;
}
async function fixtureEnvironment(db){
 const row=await db.prepare('SELECT * FROM rig_production_tenant WHERE id=1').first();if(!row)throw Error('Test tenant is required');
 return {PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_TESTONLY',RIG_PRODUCTION_MOLLIE_PROFILE:row.mollie_profile,RIG_PRODUCTION_ENVIRONMENT_ID:row.environment_id,RIG_PRODUCTION_SITE_ID:row.site_id,RIG_PRODUCTION_SITE_ORIGIN:row.site_origin,RIG_PRODUCTION_BRIDGE_ORIGIN:row.bridge_origin,RIG_PRODUCTION_WEBHOOK_URL:row.webhook_url,RIG_PRODUCTION_PACKAGES:'[]'};
}
export async function verificationForCustomer(db,userId,payload,now=Date.now(),{env}={}){
 const authenticator=await installTestCustomerCredential(db,userId,{now}),environment=env??await fixtureEnvironment(db);
 // Fixed-time fixtures can make dozens of successful operations in one minute.
 // Reset only this helper's security quota; production and quota tests do not.
 await db.prepare('DELETE FROM rig_rate_limits WHERE bucket IN (?,?)').bind('customer-security:'+userId+':GET','customer-security:'+userId+':POST').run();
 const response=await handleCustomerSecurity(new Request(CUSTOMER_ORIGIN+'/api/security/verification/options',{method:'POST',headers:{origin:CUSTOMER_ORIGIN,'content-type':'application/json'},body:JSON.stringify({operation:'customer-generation',payload})}),environment,{userId,now}),options=await response.json();
 if(!response.ok||options.required!==true)throw Object.assign(Error('Test customer security options rejected: '+JSON.stringify(options)),{status:response.status});
 return {challengeId:options.challengeId,credential:authenticator.assertion(options.publicKey)};
}
export async function beginCustomerForTest(db,stores,args,{env,now=Date.now()}={}){
 if(args.quote?.fundingKind!=='credits'||await stores.jobs.getByIdempotency(args.userId,args.idempotencyKey))return stores.jobs.begin(args);
 const temporary=['fal-ai/kling-video/o3/standard/video-to-video/edit',RECAST_MODEL].includes(args.quote.model)&&args.quote.input?.data?.transferPolicy==='fal-temporary-links-v1';
 const payload={quoteId:args.quoteId,idempotencyKey:args.idempotencyKey,...(temporary?{transferConsent:'fal-temporary-links-v1'}:{})};
 const verification=await verificationForCustomer(db,args.userId,payload,now,{env});
 return stores.jobs.begin({...args,verification,verificationPayload:payload});
}
