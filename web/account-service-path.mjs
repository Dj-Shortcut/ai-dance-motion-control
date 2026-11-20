const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export const ACCOUNT_DELETION_PATH='/api/account-deletion-requests';
export const ACCOUNT_SERVICE_OWNER_PATH='/api/owner/account-service-requests';
export const ACCOUNT_REPORT_PATH=new RegExp('^/api/generations/('+UUID+')/reports$');
export function sitesAccountServicePath(path,method){
 if(typeof path!=='string'||/[?#]/.test(path))return false;
 return path===ACCOUNT_DELETION_PATH&&['GET','POST'].includes(method)||method==='POST'&&ACCOUNT_REPORT_PATH.test(path);
}
export function ownerAccountServicePath(path,method){
 return method==='GET'&&typeof path==='string'&&new RegExp('^'+ACCOUNT_SERVICE_OWNER_PATH+'(?:\\?cursor=[0-9]{1,16}\\.'+UUID+')?$').test(path);
}
export function parseAccountServiceCursor(search){
 if(!search)return null;
 const value=new RegExp('^\\?cursor=([0-9]{1,16})\\.('+UUID+')$').exec(search);
 if(!value||!Number.isSafeInteger(Number(value[1]))||Number(value[1])<0||String(Number(value[1]))!==value[1])throw Error('Invalid request cursor');
 return {createdAt:Number(value[1]),id:value[2]};
}
