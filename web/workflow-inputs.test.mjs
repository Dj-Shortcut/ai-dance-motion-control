import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWorkflowInputStore} from './workflow-inputs.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc',SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const source=()=>readFile(new URL('./test/fixtures/input.mp4',import.meta.url));
const mask=()=>readFile(new URL('./test/fixtures/silent.mp4',import.meta.url));
async function fixture(){
 const row={mode:'live',environment_id:'input-fixture',site_id:'appgprj_6aeec13b50448191b88da670dac8aa98',site_origin:SITE,bridge_origin:BRIDGE,mollie_profile:'pfl_FIXTURE',webhook_url:BRIDGE+'/api/payments/webhook'};
 const db={prepare(sql){return {async first(){if(sql.includes('rig_production_tenant'))return row;if(sql.includes('rig_payment_environment'))return {mode:'live'};throw Error('Unexpected fixture query')}}}};
 const env={DB:{},PRODUCTION_DB:db,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'input-fixture',RIG_PRODUCTION_SITE_ID:row.site_id,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:row.webhook_url,RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:USER,RIG_OWNER_CLEANUP_VALIDATION_ENABLED:'yes'};
 const context=await createProductionGenerationContext(env),objects=new Map(),reservations=[];let now=100000,allowed=true,quota=true;
 const bucket={async put(key,bytes,options){assert.deepEqual(options.onlyIf,{etagDoesNotMatch:'*'});if(objects.has(key))return null;objects.set(key,{bytes:bytes.slice(),...structuredClone(options)});return {};},async get(key){const o=objects.get(key);if(!o)return null;return {...o,body:new Blob([o.bytes]).stream()};},async head(key){const o=objects.get(key);return o&&{...o,size:o.bytes.length};}};
 const store=createWorkflowInputStore({productionContext:context,readCurrentProductionContext:()=>createProductionGenerationContext(env),bucket,clock:()=>now,reservePreparation:async request=>{reservations.push(request);return quota;},allowRead:async()=>allowed});
 return {env,context,store,objects,reservations,setNow:v=>now=v,setRead:v=>allowed=v,setQuota:v=>quota=v};
}

test('exact owned working source and paired silent mask keep the real CFR clock, hashes and private expiry',async()=>{
 const f=await fixture(),s=await f.store.putSource({userId:USER,bytes:await source()}),m=await f.store.putMask({userId:USER,sourceId:s.id,sourceSha256:s.sha256,bytes:await mask()});
 const pair=await f.store.getPair({userId:USER,sourceId:s.id,maskId:m.id});assert.equal(pair.source.inspection.frameCount,120);assert.equal(pair.source.inspection.fpsNumerator,30);assert.equal(pair.source.inspection.hasAudio,true);assert.equal(pair.mask.inspection.hasAudio,false);assert.equal(pair.source.inspection.timelineSha256,pair.mask.inspection.timelineSha256);
 assert.equal(s.manifest.clock.firstPts,0);assert.equal(s.manifest.clock.timescale,30);assert.equal(f.reservations.length,2);
 for(const object of f.objects.values()){assert.equal(object.httpMetadata.cacheControl,'private, no-store');const metadata=JSON.parse(object.customMetadata.manifest);assert.equal(metadata.expiresAt-metadata.createdAt,86400000);assert.ok(!object.customMetadata.manifest.includes('https://'));assert.ok(!object.customMetadata.manifest.includes('input.mp4'));}
});
test('another account, changed current owner or a switched-off owner flag cannot prepare or fetch someone else’s source',async()=>{
 const f=await fixture(),s=await f.store.putSource({userId:USER,bytes:await source()});await assert.rejects(f.store.get({userId:OTHER,id:s.id}));
 await assert.rejects(f.store.putSource({userId:OTHER,bytes:await source()}));f.env.RIG_PRODUCTION_OWNER_USER_ID=OTHER;await assert.rejects(f.store.putSource({userId:USER,bytes:await source()}));f.env.RIG_PRODUCTION_OWNER_USER_ID=USER;f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='no';await assert.rejects(f.store.putSource({userId:USER,bytes:await source()}));assert.equal(f.objects.size,1);
});
test('invalid attempts consume the existing preparation budget and cannot normalize or price invented metadata',async()=>{
 const f=await fixture();await assert.rejects(f.store.putSource({userId:USER,bytes:new Uint8Array(64)}));assert.equal(f.reservations.length,1);assert.equal(f.objects.size,0);f.setQuota(false);await assert.rejects(f.store.putSource({userId:USER,bytes:await source()}),/limited/);assert.equal(f.reservations.length,2);assert.equal(f.objects.size,0);
});
test('mismatched source binding and audio-bearing masks are rejected before private storage',async()=>{
 const f=await fixture(),s=await f.store.putSource({userId:USER,bytes:await source()});await assert.rejects(f.store.putMask({userId:USER,sourceId:s.id,sourceSha256:'f'.repeat(64),bytes:await mask()}));await assert.rejects(f.store.putMask({userId:USER,sourceId:s.id,sourceSha256:s.sha256,bytes:await source()}));assert.equal(f.objects.size,1);
});
test('modified held bytes, expired records and read-limit denial fail closed',async()=>{
 const f=await fixture(),s=await f.store.putSource({userId:USER,bytes:await source()}),object=[...f.objects.values()][0],bytes=object.bytes;object.bytes=bytes.slice();object.bytes[object.bytes.length-1]^=1;await assert.rejects(f.store.get({userId:USER,id:s.id}));object.bytes=bytes;f.setRead(false);await assert.rejects(f.store.get({userId:USER,id:s.id}),/limited/);f.setRead(true);f.setNow(100000+86400000);await assert.rejects(f.store.get({userId:USER,id:s.id}),/expired/);
});
