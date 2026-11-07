import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {Miniflare}=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json')('miniflare');
test('ordered fresh schema and prepared tenant seed apply only to ephemeral local test D1',async()=>{
 const expected=['0001_test_baseline.sql','0002_public_identity.sql','0003_closed_tenant.sql','0004_test_media_work_lock.sql','0005_sponsored_invitation.sql'];
 assert.deepEqual((await readdir('closed-payment-migrations')).sort(),expected);
 for(const [file,source] of [[expected[0],'cloudflare-migrations/0001_test_baseline.sql'],[expected[1],'public-identity-schema.sql'],[expected[2],'closed-test-tenant.sql']])assert.equal(await readFile(`closed-payment-migrations/${file}`,'utf8'),await readFile(source,'utf8'));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');
  for(const file of expected){const sql=(await readFile(`closed-payment-migrations/${file}`,'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run()}
  assert.equal((await db.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first()).mode,'test');
  for(const table of ['rig_ledger','rig_orders','rig_external_identities','rig_closed_test_tenant'])assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,0);
  const seed=(await readFile('closed-tenant-seed-template.sql','utf8')).replace(/^\s*--.*$/gm,'').trim();
  const args=['closed-fixture','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook'];
  await db.prepare(seed).bind(...args).run();
  const tenant=await db.prepare('SELECT * FROM rig_closed_test_tenant WHERE id=1').first();
  assert.deepEqual([tenant.environment_id,tenant.mode,tenant.public_origin,tenant.identity_project,tenant.mollie_profile,tenant.webhook_url],[args[0],'test',...args.slice(1)]);
  await assert.rejects(db.prepare(seed).bind(...args).run());
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
 }finally{await mf.dispose()}
});

test('identity-first tenant seed leaves Mollie blank and payment activation cannot overwrite a tenant',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');
  for(const file of ['0001_test_baseline.sql','0002_public_identity.sql','0003_closed_tenant.sql','0004_test_media_work_lock.sql']){const sql=(await readFile(`closed-payment-migrations/${file}`,'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run()}
  const seed=(await readFile('closed-auth-only-tenant.sql','utf8')).replace(/^\s*--.*$/gm,'').trim();await db.prepare(seed).run();
  const row=await db.prepare('SELECT * FROM rig_closed_test_tenant WHERE id=1').first();
  assert.equal(row.environment_id,'rig-public-test-v1');assert.equal(row.identity_project,'https://fcpjgxerztaxlmfnzzsq.supabase.co');assert.equal(row.mollie_profile,'');assert.equal(row.webhook_url,'');
  const finalize=(await readFile('closed-enable-test-payments-template.sql','utf8')).replace(/^\s*--.*$/gm,'').trim();
  const params=['pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook',row.environment_id,row.public_origin,row.identity_project];
  assert.equal((await db.prepare(finalize).bind(params[0],params[1],'wrong-environment',params[3],params[4]).run()).meta.changes,0);
  assert.equal((await db.prepare(finalize).bind(...params).run()).meta.changes,1);
  assert.equal((await db.prepare(finalize).bind(...params).run()).meta.changes,0);
  await assert.rejects(db.prepare(seed).run());
 }finally{await mf.dispose()}
});
