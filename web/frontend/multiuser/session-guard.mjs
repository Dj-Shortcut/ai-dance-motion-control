// The provider session is only used as a local lifecycle signal; authorization
// still happens server-side. Same-user refreshes must not close the UI.
export async function bindSessionGuard({auth,binding,onChanged}){
 const subject=await auth.sessionSubject();
 if(!subject){binding.dispose();throw Error('Missing session');}
 let ended=false,unsubscribe=()=>{};
 const end=()=>{if(ended)return;ended=true;binding.dispose();unsubscribe();onChanged();};
 unsubscribe=auth.watchSession(next=>{if(next!==subject)end();});
 if(ended)unsubscribe();
 async function checkCurrent(){if(await auth.sessionSubject()!==subject)end();return !ended;}
 await checkCurrent();
 return {checkCurrent,stop:()=>{if(!ended){ended=true;unsubscribe();}}};
}
