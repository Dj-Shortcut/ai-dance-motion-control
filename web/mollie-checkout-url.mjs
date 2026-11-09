// Mollie may replace its hosted checkout link with its processor's redirect
// after the shopper chooses Bancontact. Accept only this observed HTTPS route.
// The backend must first verify the payment's profile, mode, amount and owner;
// this URL check is never evidence that a payment succeeded.
export function isMollieCheckoutURL(value){
 if(typeof value!=='string'||!value.length||value.length>16384||/[\u0000-\u0020\u007f]/.test(value))return false;
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)return false;
  if(url.hostname==='mollie.com'||url.hostname.endsWith('.mollie.com'))return true;
  if(url.hostname!=='redirect.ppro.com'||url.pathname!=='/v0/pages/'||url.searchParams.size!==1)return false;
  const tokens=url.searchParams.getAll('redirection_token');
  return tokens.length===1&&tokens[0].length<=8192&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tokens[0]);
 }catch{return false}
}
