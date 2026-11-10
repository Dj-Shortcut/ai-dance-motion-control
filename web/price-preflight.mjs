// Read-only provider connection check. Never accepts a caller-supplied URL or
// model and never submits media or a generation. The calling Worker must first
// authenticate the owner and apply a durable rate limit.
import {RECAST_QUALITY,RECAST_MODEL,RECAST_RESOLUTION} from './recast-contract.mjs';
const MODELS = Object.freeze({
  standard: 'fal-ai/kling-video/v3/standard/motion-control',
  pro: 'fal-ai/kling-video/v3/pro/motion-control'
});
const EDIT_ENDPOINT = 'fal-ai/kling-video/o3/standard/video-to-video/edit';
const PRICING = 'https://api.fal.ai/v1/models/pricing';

// The API's generic USD0.05 "units" is NOT a per-second rate. The exact
// Recast endpoint publishes USD0.45/output-second at 1080P, images included:
// https://fal.ai/models/minimax/h3-max/recast (reviewed 2026-11-10).
// Pin both observations as one explicit resolution-specific contract. A
// changed API unit/rate requires review; never infer another model's billing.
export const RECAST_BILLING=Object.freeze({id:'minimax-h3-max-recast-1080p-20261110',endpoint:RECAST_MODEL,resolution:RECAST_RESOLUTION,providerUnit:'units',providerUnitPrice:0.05,usdMicrosPerSecond:450000});
export function recastPricePerSecond(value){
  const contract=value?.billingContracts?.[RECAST_QUALITY];
  if(value?.provider!=='fal'||value.currency!=='USD'||value.unit!=='second'||value.prices?.[RECAST_QUALITY]!==RECAST_BILLING.usdMicrosPerSecond/1e6||!contract||typeof contract!=='object'||Array.isArray(contract)||Object.keys(contract).length!==Object.keys(RECAST_BILLING).length||!Object.keys(RECAST_BILLING).every(key=>Object.hasOwn(contract,key)&&Object.is(contract[key],RECAST_BILLING[key])))throw Error('Recast billing unavailable');
  return RECAST_BILLING.usdMicrosPerSecond/1e6;
}

async function smallJson(response) {
  if (!response.ok) throw Error('unavailable');
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mime !== 'application/json') throw Error('unavailable');
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 65536)) throw Error('unavailable');
  if (!response.body) throw Error('unavailable');
  const reader = response.body.getReader();
  let total = 0, timer;
  const chunks = [];
  const deadline = new Promise((_, reject) => {timer = setTimeout(() => reject(Error('unavailable')), 10000)});
  try {
    while (true) {
      const {done, value} = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > 65536) throw Error('unavailable');
      chunks.push(value);
    }
  } finally { clearTimeout(timer); try { void reader.cancel().catch(() => {}); } catch {} }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
}

export async function getFalPricePreflight(key, fetchImpl=fetch, {includeEdit=false,includeRecast=false,quality}={}) {
  if (typeof key !== 'string' || !key || key.length > 1024 || /[\r\n]/.test(key)) throw Error('unavailable');
  if (typeof includeEdit!=='boolean'||typeof includeRecast!=='boolean') throw Error('unavailable');
  const prices = {};
  const allowed={...MODELS,...(includeEdit?{'edit-standard':EDIT_ENDPOINT}:{}),...(includeRecast?{[RECAST_QUALITY]:RECAST_MODEL}:{})};
  if(quality!==undefined&&(typeof quality!=='string'||!Object.hasOwn(allowed,quality)))throw Error('unavailable');
  const models=quality===undefined?allowed:{[quality]:allowed[quality]};
  for (const [quality, endpoint] of Object.entries(models)) {
    const url = new URL(PRICING);
    url.searchParams.set('endpoint_id', endpoint);
    const res = await fetchImpl(url.href, {method:'GET', redirect:'manual', signal:AbortSignal.timeout(10000), headers:{Authorization:`Key ${key}`, Accept:'application/json'}});
    const body = await smallJson(res);
    const matches = Array.isArray(body?.prices) ? body.prices.filter(x => x?.endpoint_id === endpoint) : [];
    if (matches.length !== 1) throw Error('unavailable');
    const price = matches[0];
    if(quality===RECAST_QUALITY){
      if(price.currency!=='USD'||price.unit!==RECAST_BILLING.providerUnit||price.unit_price!==RECAST_BILLING.providerUnitPrice)throw Error('Recast billing unavailable');
      prices[quality]=RECAST_BILLING.usdMicrosPerSecond/1e6;
    }else{
      if (price.currency !== 'USD' || !['second','seconds'].includes(String(price.unit).toLowerCase()) || !Number.isFinite(price.unit_price) || price.unit_price < 0 || price.unit_price > 1000) throw Error('unavailable');
      prices[quality] = price.unit_price;
    }
  }
  return {provider:'fal', currency:'USD', unit:'second', prices, estimateOnly:true,...(Object.hasOwn(prices,RECAST_QUALITY)?{billingContracts:{[RECAST_QUALITY]:{...RECAST_BILLING}}}:{})};
}
