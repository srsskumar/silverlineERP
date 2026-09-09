import * as Crypto from 'expo-crypto';
import {Platform} from 'react-native';
import {enqueueOp} from '../sync/queue';
import {getAccount} from '../sync/db';

/** Persist only a fingerprint and category. Never send error messages or stack text. */
export async function reportClientError(error:Error,fatal=false){
 try{
  if(!await getAccount())return;
  const fingerprint=await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,error.stack??error.name);
  await enqueueOp({entity:'client_error',op:`crash:${fingerprint}`,payload:{fingerprint,category:fatal?'FATAL_JS':'RENDER_JS',platform:Platform.OS==='android'?'android':'ios',app_version:'1.0.0'}});
 }catch{/* Reporting must never cause a second application failure. */}
}
