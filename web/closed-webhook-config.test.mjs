import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import webhook from './closed-webhook-worker.mjs';
test('webhook configuration is separate, test-only and has no secrets',async()=>{
 const source=await readFile(new URL('./wrangler.closed-webhook.toml',import.meta.url),'utf8');
 for(const pattern of [/^workers_dev\s*=\s*true$/m,/^preview_urls\s*=\s*false$/m,/^RIG_WEBHOOK_TEST_ENABLED\s*=\s*"yes"$/m,/^RIG_MODE\s*=\s*"test"$/m,/^RIG_MOLLIE_MODE\s*=\s*"test"$/m,/^binding\s*=\s*"RIG_STAGING_SERVICE"$/m])assert.match(source,pattern);
 assert.match(source,/^\[\[ratelimits\]\]$/m);assert.match(source,/^name\s*=\s*"RIG_WEBHOOK_LIMITER"$/m);
 assert.match(source,/^namespace_id\s*=\s*"913749206"$/m);assert.match(source,/^\s*limit\s*=\s*60$/m);assert.match(source,/^\s*period\s*=\s*60$/m);
 assert.doesNotMatch(source,/^(?:route|routes|MOLLIE_API_KEY|FAL_KEY)\s*=/m);
 const r=await webhook.fetch(new Request('https://hooks.rig.local/api/payments/webhook',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=tr_FAKE123456'}),{});assert.equal(r.status,503);
});
