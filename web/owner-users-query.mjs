// Shared transport validation only. Authority and cursor authenticity stay in
// the private production service; the browser can only select a bounded page.
export const OWNER_USERS_CURSOR_MAX=320;
export const OWNER_USERS_CURSOR=/^[A-Za-z0-9_-]{1,255}\.[a-f0-9]{64}$/;
export function parseOwnerUsersQuery(path){
 if(typeof path!=='string'||path.length>1200||/[#\\\r\n]/.test(path))return null;
 let url;try{url=new URL(path,'https://rig.invalid')}catch{return null}
 if(url.origin!=='https://rig.invalid'||url.pathname!=='/api/owner/users'||url.pathname+url.search!==path||path.endsWith('?'))return null;
 // URLSearchParams accepts malformed percent escapes. The signed transport
 // rejects them rather than letting layers disagree about the search value.
 try{for(const part of url.search.slice(1).split('&'))if(part)decodeURIComponent(part.replaceAll('+',' '))}catch{return null}
 const params=url.searchParams,names=[...params.keys()];
 if(names.some(name=>!['limit','cursor','q'].includes(name))||new Set(names).size!==names.length)return null;
 const limit=params.has('limit')?Number(params.get('limit')):25;
 if(params.has('limit')&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(params.get('limit'))||!Number.isSafeInteger(limit))return null;
 const q=params.get('q')??'';
 if(q.length>100||q!==q.trim()||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(q))return null;
 const cursor=params.get('cursor');
 if(cursor!==null&&(cursor.length>OWNER_USERS_CURSOR_MAX||!OWNER_USERS_CURSOR.test(cursor)))return null;
 return {limit,q,cursor};
}
export function sitesUsersPath(path,method){return method==='GET'&&parseOwnerUsersQuery(path)!==null}
