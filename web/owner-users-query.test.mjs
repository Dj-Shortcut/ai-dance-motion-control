import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOwnerUsersQuery,sitesUsersPath} from './owner-users-query.mjs';
import {sitesPath,sitesAdministrationPath,sitesInternalAccountActivityPath,sitesRequestBodyLimit} from './sites-bridge-protocol.mjs';
import {signSitesBridgeRequest} from './sites-bridge-protocol.mjs';
import {authenticateSitesBridge} from './sites-bridge-auth.mjs';

test('owner users transport exposes only a bounded GET search/page and exact internal producer POST',()=>{
 const cursor='a'.repeat(160)+'.'+'b'.repeat(64);
 for(const path of ['/api/owner/users','/api/owner/users?limit=1','/api/owner/users?limit=50','/api/owner/users?q=Alice+Example&limit=25','/api/owner/users?cursor='+cursor]){
  assert.equal(sitesUsersPath(path,'GET'),true,path);assert.equal(sitesAdministrationPath(path,'GET'),true,path);assert.equal(sitesPath(path,'GET'),true,path);
 }
 assert.deepEqual(parseOwnerUsersQuery('/api/owner/users'),{limit:25,q:'',cursor:null});
 assert.deepEqual(parseOwnerUsersQuery('/api/owner/users?q=J%C3%A9r%C3%B4me'),{limit:25,q:'Jérôme',cursor:null});
 for(const path of ['/api/owner/users/','/api/owner/users?','/api/owner/users?limit=0','/api/owner/users?limit=51','/api/owner/users?limit=01','/api/owner/users?limit=1e1','/api/owner/users?limit=-1','/api/owner/users?limit=10&limit=20','/api/owner/users?role=owner','/api/owner/users?email=x','/api/owner/users?q=a&q=b','/api/owner/users?q=%00','/api/owner/users?q=%20Alice','/api/owner/users?q='+('a'.repeat(101)),'/api/owner/users?q=%ZZ','/api/owner/users?q=%E0%A4','/api/owner/users?cursor=arbitrary','/api/owner/users#x'])assert.equal(sitesPath(path,'GET'),false,path);
 assert.equal(sitesPath('/api/owner/users','POST'),false);assert.equal(sitesPath('/api/owner/users','HEAD'),false);
 assert.equal(sitesInternalAccountActivityPath('/api/internal/account-activity','POST'),true);
 assert.equal(sitesPath('/api/internal/account-activity','POST'),true);
 assert.equal(sitesRequestBodyLimit('/api/internal/account-activity','POST'),2048);
 for(const [path,method]of [['/api/internal/account-activity','GET'],['/api/internal/account-activity','HEAD'],['/api/internal/account-activity/','POST'],['/api/internal/account-activity?','POST'],['/api/internal/account-activity?user=forged','POST']])assert.equal(sitesPath(path,method),false,path);
});

test('legacy test bridge cannot accept production profile producer calls',async()=>{
 let databaseTouched=false;
 const env={RIG_SITES_BRIDGE_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_SITES_PROJECT_ID:'appgprj_12345678901234567890',RIG_SITES_PRODUCER_ORIGIN:'https://test-site.invalid',RIG_SITES_BRIDGE_ORIGIN:'https://test-bridge.invalid',RIG_SITES_BRIDGE_KEY:'ab'.repeat(32),DB:{prepare(){databaseTouched=true;throw Error('No database access permitted')}}};
 const request=await signSitesBridgeRequest({env,subject:'native-test-subject',path:'/api/internal/account-activity',method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode('{"displayName":null,"email":null}')});
 assert.equal(await authenticateSitesBridge(request,env,{leaseFactory:()=>{throw Error('No media lease permitted')}}),null);assert.equal(databaseTouched,false);
});
