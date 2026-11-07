// Deliberate test tokens and identities. Never connected to an account.
const users={'a.b.c':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','d.e.f':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
export default {async fetch(req){
 const u=new URL(req.url);
 if(u.origin!=='https://abcdefghijklmnopqrst.supabase.co'||u.pathname!=='/auth/v1/user'||req.method!=='GET'||req.headers.get('apikey')!=='sb_publishable_fixturekey12345')return new Response(null,{status:400});
 const token=(req.headers.get('authorization')||'').replace(/^Bearer /,''),id=users[token];
 return id?Response.json({id}):Response.json({msg:'Invalid test token'},{status:401});
}};
