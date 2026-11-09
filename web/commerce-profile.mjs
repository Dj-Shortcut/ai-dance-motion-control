// Public seller information. Home address was explicitly approved for publication.
export const COMMERCE_VERSION='rig-commerce-2026-11-09-v1';
export const merchant=Object.freeze({brand:'RIG',legalName:'Andy Arys',enterpriseNumber:'1040.495.145',vatNumber:'BE1040.495.145',address:'Savooistraat 50, 9400 Ninove, België',email:'info@andyarijs.dev',phone:'+32 486 25 07 05',country:'BE',customerCountries:Object.freeze(['BE','NL'])});
export function publicCommerce(){return {version:COMMERCE_VERSION,merchant,customerType:'consumer',countries:merchant.customerCountries,currency:'EUR',termsPath:'/voorwaarden',privacyPath:'/privacy',supportPath:'/hulp',sellerPath:'/bedrijfsgegevens'};}
