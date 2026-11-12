// Explicit dependency for tests of other subsystems, not a runtime flag or an
// HTTP-controlled bypass. Funding admission itself has separate real-D1 tests.
// Production entrypoints never import this module and use the strict defaults.
export const testCheckoutFunding=Object.freeze({
 orderAdmission:async()=>({before:[],gate:{sql:'1',params:[]}}),
 coverageReader:async()=>({enabled:true,status:'ready',newCreditCapacityCents:100000000})
});
