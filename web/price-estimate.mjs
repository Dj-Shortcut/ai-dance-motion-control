// Owner-only, test-mode preview. This is neither a charge nor a firm quote.
// Rates reflect the fal account/catalog check on 7 November 2026; verify them
// again before taking money or making a provider call.
const rates = Object.freeze({ standard: 126000, pro: 168000 }); // USD millionths per output second
const invalid = () => Response.json({error:'Kies een fragment van 3 tot 30 seconden.'},{status:400,headers:{'cache-control':'no-store'}});

export function estimatePrice(quality, duration, proposedCents, proposalVersion) {
  if (!Object.hasOwn(rates,quality) || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 3 || duration > 30) return null;
  const billedSeconds = Math.ceil(duration);
  const usdMicros = billedSeconds * rates[quality];
  // Customer pricing is intentionally absent by default. If explicitly
  // configured it is still only an illustrative test proposal, never a quote
  // or a rate usable by the ledger or generation flow.
  const cents = typeof proposedCents === 'string' && /^[1-9][0-9]{0,3}$/.test(proposedCents) ? Number(proposedCents) : null;
  const version = typeof proposalVersion === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(proposalVersion) ? proposalVersion : null;
  const customerProposal = cents && version ? {currency:'EUR', priceCents:billedSeconds*cents, version, binding:false} : null;
  return {quality, durationSeconds:duration, billedSeconds, providerEstimate:{currency:'USD',usdMicros,rateUsdMicrosPerSecond:rates[quality],rateCheckedOn:'2026-11-07',binding:false},customerProposal};
}

export function handlePriceEstimate(req, env) {
  if (env.RIG_MODE !== 'test' || env.RIG_ESTIMATE_PREVIEW_ENABLED !== 'yes') return Response.json({error:'Raming niet beschikbaar.'},{status:503,headers:{'cache-control':'no-store'}});
  if (req.method !== 'GET') return Response.json({error:'Methode niet toegestaan.'},{status:405,headers:{'cache-control':'no-store'}});
  const params=new URL(req.url).searchParams;
  if ([...params.keys()].some(key=>!['quality','duration'].includes(key)) || params.getAll('quality').length!==1 || params.getAll('duration').length!==1) return invalid();
  const quality=params.get('quality'), raw=params.get('duration');
  if (!/^(?:[0-9]{1,2})(?:\.[0-9]{1,6})?$/.test(raw || '')) return invalid();
  const result=estimatePrice(quality,Number(raw),quality==='standard'?env.RIG_ESTIMATE_EUR_STANDARD_CENTS:env.RIG_ESTIMATE_EUR_PRO_CENTS,env.RIG_ESTIMATE_EUR_VERSION);
  return result ? Response.json(result,{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}}) : invalid();
}
