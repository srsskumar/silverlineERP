import * as SecureStore from 'expo-secure-store';
import {randomUUID} from 'expo-crypto';
import {apiFetch} from '../api/client';
export async function deviceId():Promise<string>{let id=await SecureStore.getItemAsync('silverline.device_id');if(!id){id=randomUUID();await SecureStore.setItemAsync('silverline.device_id',id);}return id;}
export async function registerDevice(pushToken?:string):Promise<void>{const {data}=await apiFetch<{revoked_at:string|null}>('/api/v1/devices/register',{method:'POST',body:{device_id:await deviceId(),...(pushToken?{push_token:pushToken}:{})}});if(data.revoked_at)throw new Error('This device was revoked. Contact your administrator.');}
