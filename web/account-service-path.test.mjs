import test from 'node:test';
import assert from 'node:assert/strict';
import {sitesAccountServicePath,ownerAccountServicePath,parseAccountServiceCursor} from './account-service-path.mjs';
import {sitesPath,sitesAdministrationPath} from './sites-bridge-protocol.mjs';
import {nativeApiPath} from './native-api.mjs';

const id='12345678-1234-4123-8123-123456789abc';
test('account request transport is exact and exposes no native administration or deletion operation',()=>{
 for(const [path,method] of [['/api/account-deletion-requests','GET'],['/api/account-deletion-requests','POST'],[`/api/generations/${id}/reports`,'POST']]){
  assert.equal(sitesAccountServicePath(path,method),true,path);assert.equal(sitesPath(path,method),true,path);
  assert.equal(nativeApiPath(path.replace('/api/','/api/native/'),method),path);
 }
 for(const [path,method] of [['/api/account-deletion-requests?user=other','POST'],['/api/account-deletion-requests','DELETE'],['/api/account-deletion-requests/confirm','POST'],[`/api/generations/${id}/reports`,'GET'],[`/api/generations/${id}/reports?owner=true`,'POST'],['/api/generations/not-a-uuid/reports','POST'],['/api/owner/account-service-requests','POST']]){
  assert.equal(sitesAccountServicePath(path,method),false,path);assert.equal(sitesPath(path,method),false,path);
  assert.equal(nativeApiPath(path.replace('/api/','/api/native/'),method),null,path);
 }
 assert.equal(ownerAccountServicePath('/api/owner/account-service-requests','GET'),true);
 assert.equal(sitesAdministrationPath('/api/owner/account-service-requests','GET'),true);
 assert.equal(nativeApiPath('/api/native/owner/account-service-requests','GET'),null);
});
test('owner queue accepts only one bounded canonical timestamp and UUID cursor',()=>{
 assert.equal(parseAccountServiceCursor(''),null);
 assert.deepEqual(parseAccountServiceCursor('?cursor=123.'+id),{createdAt:123,id});
 assert.equal(sitesPath('/api/owner/account-service-requests?cursor=123.'+id,'GET'),true);
 for(const query of ['?cursor=001.'+id,'?cursor=9007199254740992.'+id,'?cursor=-1.'+id,'?cursor=123.bad','?cursor=123.'+id+'&user=other','?cursor=123.'+id+'&cursor=123.'+id,'?user=other'])assert.throws(()=>parseAccountServiceCursor(query));
});
