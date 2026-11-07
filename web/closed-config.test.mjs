import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('deployed login uses the separate test D1 and keeps secrets, video and private routes out of public config',async()=>{
 const ingress=await readFile('wrangler.closed-ingress.toml','utf8'),backend=await readFile('wrangler.closed-private.toml','utf8');
 for(const source of [ingress,backend]){
  assert.match(source,/^account_id\s*=\s*"dec4748551308f47fca7f9f9eede649d"$/m);
  assert.match(source,/^preview_urls\s*=\s*false$/m);
  assert.match(source,/^RIG_MODE\s*=\s*"test"$/m);assert.match(source,/^RIG_MOLLIE_MODE\s*=\s*"test"$/m);
  assert.doesNotMatch(source,/^(?:FAL_KEY|MOLLIE_API_KEY)\s*=/m);
 }
 assert.match(backend,/^workers_dev\s*=\s*false$/m);
 assert.match(backend,/^database_id\s*=\s*"4d7faaf4-a30c-4268-add7-702a8e157e1c"$/m);
 assert.match(backend,/^migrations_dir\s*=\s*"closed-payment-migrations"$/m);
 assert.doesNotMatch(backend,/ab39fc37-f8a8-4553-ac7c-18e29db32c7b|^RIG_CLOSED_VIDEO_ENABLED\s*=\s*"yes"/m);
 assert.match(backend,/^RIG_MOLLIE_PROFILE_ID\s*=\s*"pfl_uVYGED9uCC"$/m);
 assert.match(backend,/^RIG_PACKAGES\s*=\s*'/m);
 const inert=await readFile('wrangler.toml','utf8');assert.match(inert,/^main\s*=\s*"closed-inert-worker.mjs"$/m);assert.match(inert,/^workers_dev\s*=\s*false$/m);
});
