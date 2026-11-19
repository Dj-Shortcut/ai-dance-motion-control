import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayAccessTokenProvider,GOOGLE_PLAY_OAUTH_URL,GOOGLE_PLAY_OAUTH_SCOPE} from './google-play-oauth.mjs';
import {createGooglePlayTokenVault} from './google-play-token-vault.mjs';
import {playBase64Url,playFromBase64Url,playEncode,playSha256} from './google-play-provider-common.mjs';
import {providerKeys,providerNow} from './google-play-provider-fixture.mjs';

test('OAuth and vault disabled defaults read no credential or network',async()=>{
 const oauth=createGooglePlayAccessTokenProvider({get serviceAccount(){throw Error('secret read')}}),vault=createGooglePlayTokenVault({get keys(){throw Error('key read')}});
 await assert.rejects(oauth.getAccessToken(),{code:'play_oauth_setup'});await assert.rejects(vault.seal({}),{code:'play_vault_setup'});
});
test('service-account assertion uses real RS256, exact Google endpoint/scope, concurrent bounded token cache',async()=>{
 const f=await providerKeys();let at=providerNow,count=0;
 const oauth=createGooglePlayAccessTokenProvider({enabled:true,serviceAccount:JSON.stringify(f.account),now:()=>at,network:async(url,options)=>{
  count++;assert.equal(url,GOOGLE_PLAY_OAUTH_URL);assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');assert.equal(options.method,'POST');
  const body=new URLSearchParams(options.body);assert.equal(body.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [head,claim,sig]=body.get('assertion').split('.'),header=JSON.parse(new TextDecoder().decode(playFromBase64Url(head))),claims=JSON.parse(new TextDecoder().decode(playFromBase64Url(claim)));
  assert.equal(header.alg,'RS256');assert.equal(header.kid,f.account.private_key_id);assert.equal(claims.aud,GOOGLE_PLAY_OAUTH_URL);assert.equal(claims.scope,GOOGLE_PLAY_OAUTH_SCOPE);assert.equal(claims.iss,f.account.client_email);assert.equal(claims.exp-claims.iat,300);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',f.keys.publicKey,playFromBase64Url(sig),playEncode(head+'.'+claim)),true);
  return Response.json({access_token:'ya29.fake-fixture-token',token_type:'Bearer',expires_in:3600});
 }});
 assert.deepEqual(await Promise.all([oauth.getAccessToken(),oauth.getAccessToken()]),['ya29.fake-fixture-token','ya29.fake-fixture-token']);assert.equal(count,1);
 at+=1000;await oauth.getAccessToken();assert.equal(count,1);at+=3590000;await oauth.getAccessToken();assert.equal(count,2);
 oauth.clear();await oauth.getAccessToken();assert.equal(count,3);
});
test('OAuth rejects alternate token URI, malformed responses/redirects, and exposes no raw keys/provider error',async()=>{
 const f=await providerKeys();assert.throws(()=>createGooglePlayAccessTokenProvider({enabled:true,serviceAccount:{...f.account,token_uri:'https://attacker.invalid'},network:()=>{}}),{code:'play_oauth_setup'});
 for(const network of [async()=>Response.json({access_token:'secret-token',expires_in:3600,token_type:'Bearer'}),async()=>Response.json({access_token:'ya29.fake-fixture-token',expires_in:7200,token_type:'Bearer'}),async()=>new Response(null,{status:302}),async()=>{throw Error(f.pem)}]){
  const oauth=createGooglePlayAccessTokenProvider({enabled:true,serviceAccount:f.account,network,now:()=>providerNow});await assert.rejects(oauth.getAccessToken(),e=>e.code==='play_oauth'&&!String(e).includes('PRIVATE KEY')&&!String(e).includes('secret-token'));
 }
});
test('AES-GCM vault randomizes ciphertext and authenticates app/mode/token hash, without token plaintext',async()=>{
 const token='private-fixture-purchase-token',tokenHash=await playSha256(token),key=playBase64Url(crypto.getRandomValues(new Uint8Array(32)));
 const vault=createGooglePlayTokenVault({enabled:true,currentKeyId:'v1',keys:{v1:key}}),input={purchaseToken:token,tokenHash,mode:'live'};
 const a=await vault.seal(input),b=await vault.seal(input);assert.notEqual(a,b);assert.ok(a.length<8192);assert.ok(!a.includes(token));assert.equal(await vault.open({sealedToken:a,tokenHash,mode:'live'}),token);
 for(const changed of [{mode:'test'},{tokenHash:'a'.repeat(64)},{sealedToken:a.slice(0,-1)+(a.endsWith('A')?'B':'A')},{sealedToken:a.replace('.v1.','.v2.')}])await assert.rejects(vault.open({sealedToken:a,tokenHash,mode:'live',...changed}));
 await assert.rejects(vault.seal({...input,tokenHash:'a'.repeat(64)}),{code:'play_vault_binding'});
});
test('vault key rotation can retain the old key; dropping it fails closed',async()=>{
 const token='fixture-rotation-token',tokenHash=await playSha256(token),old=playBase64Url(crypto.getRandomValues(new Uint8Array(32))),fresh=playBase64Url(crypto.getRandomValues(new Uint8Array(32)));
 const a=createGooglePlayTokenVault({enabled:true,currentKeyId:'old',keys:{old}}),sealedToken=await a.seal({purchaseToken:token,tokenHash,mode:'test'});
 const b=createGooglePlayTokenVault({enabled:true,currentKeyId:'new',keys:{old,new:fresh}});assert.equal(await b.open({sealedToken,tokenHash,mode:'test'}),token);
 const c=createGooglePlayTokenVault({enabled:true,currentKeyId:'new',keys:{new:fresh}});await assert.rejects(c.open({sealedToken,tokenHash,mode:'test'}),{code:'play_vault_open'});
});
