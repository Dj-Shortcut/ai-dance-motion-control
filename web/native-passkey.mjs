// A module-private capability distinguishes native dispatch from ordinary web
// traffic. It survives internal env composition but cannot be supplied by a
// header, JSON field, Cloudflare text binding or browser origin.
const nativeTransport=Symbol('rig-native-authenticated-transport');
export function nativeTransportEnvironment(env){return {...env,[nativeTransport]:true};}
export function isNativeTransport(env){return env?.[nativeTransport]===true;}
export function configuredAndroidOrigin(env){
 const fingerprint=env?.RIG_NATIVE_ANDROID_SIGNING_SHA256;
 if(typeof fingerprint!=='string'||!/^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(fingerprint))return null;
 const bytes=Uint8Array.from(fingerprint.split(':'),part=>parseInt(part,16));
 return 'android:apk-key-hash:'+btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function passkeyOrigin(env,webOrigin){return isNativeTransport(env)?configuredAndroidOrigin(env):webOrigin;}
