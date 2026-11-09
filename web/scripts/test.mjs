import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureFixtures} from './generate-fixtures.mjs';
// Explicit regression gates. Operator/deployment scripts are never executed.
const groups={
 unit:[
  'invoice-pdf','invoice-mail','commerce-documents','commerce-ui','commerce-routes','owner-administration-operations','owner-administration-ui','profit-policy','owner-security-client','owner-finance-ui','mollie-checkout-url','edit-mode-ui','local-media-security-ui','owner-provider-ui','native-site-ui','multiuser-trim-ui','video-capability','ui-lifecycle','invitation-ui',
  'sponsored-generation-ui','sponsored-payments-ui','multiuser-ui-integration','closed-payment-ui',
  'browser-recording-integrity','browser-frame-padding','browser-edit-dimensions','rig-mcp','rig-chatgpt-files','rig-sites-app','build-rig-sites',
  'generation','rig-inline-inputs','rig-inline-assets','rig-inline-generation','rig-r2-delivery','rig-r2-inputs','payment','payment-body','payment-rejections','private-upload','provider-response','result-store',
  'price-estimate','price-preflight','media-binding','media-redirect','consent-assets','production-bridge-auth',
  'credit-ledger-paging','webhook-bridge','webhook-worker','owner-fal-guard','closed-video-worker','sites-provider-relay','production-ingress'
 ],
 workerd:[
  'invoice-store-workerd','invoice-payment-workerd','invoice-delivery-workerd','purchase-billing-workerd','commercial-checkout-workerd','customer-support-workerd','accounting-export-workerd','owner-recovery-workerd','preparation-budget-workerd','owner-security-workerd','profit-guard-workerd','owner-finance-workerd','sites-bridge','closed-video-worker-workerd','credit-ledger-workerd','sponsor-input-refund','rig-input-verification','rig-r2-verification','rig-provider-inputs',
  'durable-media-lease','sponsored-invitation','closed-fresh-d1','sponsored-video-workerd','production-payment-workerd','production-private-workerd','production-commerce-workerd','production-readiness-workerd','production-invitation-workerd','production-video-workerd','owner-provider-funding-workerd','production-collector-workerd','gateway-relay-workerd'
 ],
 media:['mp4-inspect','mp4-edit-support','video-preparer','cloud-media-service','long-duration','closed-video-service','normalize']
};
const group=process.argv[2];if(!Object.hasOwn(groups,group)||process.argv.length!==3)throw Error('Choose unit, workerd or media.');
await ensureFixtures();
const env={...process.env};
for(const key of Object.keys(env))if(/^(?:FAL_|MOLLIE_|ZOHO_|CLOUDFLARE_|CF_|RIG_|SUPABASE_)/.test(key))delete env[key];
env.CLOUDFLARE_CF_FETCH_ENABLED='false';env.WRANGLER_SEND_METRICS='false';
const result=spawnSync(process.execPath,['--test','--test-concurrency='+ (group==='unit'?'2':'1'),...groups[group].map(name=>name+'.test.mjs')],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:'inherit',env});
if(result.error)throw result.error;
process.exitCode=result.status??1;
