import {AESEncryptionKey,AESSealedData,aesEncryptAsync,aesDecryptAsync} from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
const keys=new Map<string,Promise<AESEncryptionKey>>();
async function keyFor(account:string):Promise<AESEncryptionKey>{
 if(!keys.has(account))keys.set(account,(async()=>{const name=`silverline.vault.${account}`;const saved=await SecureStore.getItemAsync(name);if(saved)return AESEncryptionKey.import(saved,'hex');const key=await AESEncryptionKey.generate();await SecureStore.setItemAsync(name,await key.encoded('hex'));return key;})());
 return keys.get(account)!;
}
export async function seal(account:string,value:string):Promise<string>{const encrypted=await aesEncryptAsync(new TextEncoder().encode(value),await keyFor(account));return 'aes1:'+await encrypted.combined('base64');}
export async function unseal(account:string,value:string):Promise<string>{if(!value.startsWith('aes1:'))return value;const bytes=await aesDecryptAsync(AESSealedData.fromCombined(value.slice(5)),await keyFor(account));return new TextDecoder().decode(bytes);}
export async function destroyVault(account:string){keys.delete(account);await SecureStore.deleteItemAsync(`silverline.vault.${account}`);}
