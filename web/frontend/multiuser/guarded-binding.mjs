import {bindSessionGuard} from './session-guard.mjs';
import {prepareBoundUi} from './ui-auth.mjs';

// Observe the session *before* asking the backend for its account ID. If the
// user changes during the network request, discard the late binding entirely.
export async function prepareGuardedBinding({auth,browser,onChanged}){
 let binding=null,interrupted=false;
 const proxy={dispose(){interrupted=true;binding?.dispose();}};
 const guard=await bindSessionGuard({auth,binding:proxy,onChanged});
 try{
  if(interrupted)throw Error('De aanmelding is gewijzigd.');
  binding=await prepareBoundUi({auth,browser});
  if(interrupted || !await guard.checkCurrent()){binding.dispose();throw Error('De aanmelding is gewijzigd.');}
  return {binding,stop:guard.stop};
 }catch(error){binding?.dispose();guard.stop();throw error;}
}
