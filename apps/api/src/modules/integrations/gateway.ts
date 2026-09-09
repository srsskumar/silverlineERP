import {z} from 'zod';
export const PROVIDERS=['SMS','WHATSAPP','WEATHER','ACCOUNTING'] as const;
export type Provider=typeof PROVIDERS[number];
export class ProviderError extends Error {constructor(readonly code:string,readonly retryable:boolean){super(code);}}
/** Operators configure their own vendor adapter. Credentials never leave the server. */
export function providerConfig(provider:Provider){
 const prefix=`PROVIDER_${provider}`,endpoint=process.env[`${prefix}_URL`],token=process.env[`${prefix}_TOKEN`];
 let valid=false;try{const url=new URL(endpoint??'');valid=url.protocol==='https:'&&!url.username&&!url.password&&!url.hash;}catch{/* unconfigured */}
 return {enabled:process.env[`${prefix}_ENABLED`]==='true'&&valid&&!!token,endpoint,token};
}
export async function callProvider(provider:Provider,payload:unknown,key:string,fetcher:typeof fetch=fetch):Promise<Record<string,unknown>>{
 const config=providerConfig(provider);if(!config.enabled)throw new ProviderError('PROVIDER_NOT_CONFIGURED',false);
 let response:Response;
 try{response=await fetcher(config.endpoint!,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${config.token}`,'idempotency-key':key},body:JSON.stringify({schema_version:1,provider:provider.toLowerCase(),payload}),signal:AbortSignal.timeout(10000)});}catch{throw new ProviderError('PROVIDER_UNAVAILABLE',true);}
 if(!response.ok)throw new ProviderError(`HTTP_${response.status}`,response.status>=500||response.status===429||response.status===408);
 try{
  const reader=response.body?.getReader();if(!reader)throw new Error();let length=0;const chunks:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>1024*1024)throw new Error();chunks.push(value);}}finally{await reader.cancel();}
  return z.record(z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
 }catch{throw new ProviderError('INVALID_PROVIDER_RESPONSE',false);}
}
export const weatherResponse=z.object({observed_at:z.string().datetime(),summary:z.string().max(500),temperature_c:z.number().min(-100).max(70),precipitation_probability:z.number().min(0).max(1),alerts:z.array(z.object({severity:z.enum(['INFO','WATCH','WARNING']),message:z.string().max(500)})).max(20)});
