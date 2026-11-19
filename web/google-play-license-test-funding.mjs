// Private license harness only. A live DB can never take this path. The caller
// additionally pins distinct physical DB IDs and authorized test operators.
const USER=/^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=()=>Object.assign(Error('Google Play-licentietest is niet ingeschakeld.'),{code:'play_license_test_setup'});
export async function prepareGooglePlayLicenseTestFunding({DB,now=Date.now()}={}){
 if(typeof DB?.prepare!=='function'||typeof DB?.batch!=='function'||!Number.isSafeInteger(now)||now<=0)throw fail();
 const mode=await DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();if(mode?.mode!=='test')throw fail();
 const policy=await DB.prepare('SELECT * FROM rig_google_play_test_policy WHERE id=1').first();
 let users;try{users=JSON.parse(policy?.allowed_users_json)}catch{throw fail()}
 if(policy?.enabled!==1||!Number.isSafeInteger(policy.budget_credit_cents)||policy.budget_credit_cents<500||policy.budget_credit_cents>10000||!Number.isSafeInteger(policy.expires_at)||policy.expires_at<=now||!Array.isArray(users)||users.length<1||users.length>32||users.some(user=>!USER.test(user)))throw fail();
 const snapshotId=crypto.randomUUID();
 const before=[DB.prepare('INSERT INTO rig_funding_snapshots(id,funding_version,finance_version,finance_json,username,balance_usd_micros,usd_micros_per_euro_cent,buffer_usd_micros,fetched_at,expires_at) VALUES(?,?,?,?,?,0,1,0,?,?)').bind(snapshotId,'google-license-test-v1','google-license-test-v1','{"version":"google-license-test-v1"}','google-license-test',now,now+60000)];
 return {before,snapshotId};
}
