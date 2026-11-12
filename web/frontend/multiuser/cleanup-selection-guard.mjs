import {CleanupError,selection,stableJson} from './cleanup-contract.mjs';
export function selectionGuard({getBinding,readSelection,signal}){
 const bound=getBinding(),chosen=selection(readSelection()),serialized=stableJson(chosen);
 const current=()=>{const now=getBinding();return !signal?.aborted&&now?.request===bound?.request&&now?.active===bound?.active&&now?.storage===bound?.storage&&typeof bound?.active==='function'&&bound.active()===true&&stableJson(selection(readSelection()))===serialized;};
 const assert=()=>{try{if(current())return;}catch{}throw new CleanupError('stale','Je selectie of aanmelding is gewijzigd. Bereid het fragment opnieuw voor.');};assert();return {chosen,serialized,assert,current};
}
