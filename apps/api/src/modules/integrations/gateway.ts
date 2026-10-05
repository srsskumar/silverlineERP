import {z} from 'zod';
export const PROVIDERS=['SMS','WHATSAPP','WEATHER','ACCOUNTING','GSTIN'] as const;
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
/**
 * What the operator's GSTIN adapter is expected to normalize the GSTN
 * taxpayer lookup into, independent of whichever GSP/aggregator they've
 * actually wired up behind PROVIDER_GSTIN_URL. `legal_name` is the one a
 * client's own record should be checked against -- a trade name is what
 * the business calls itself, not who it legally is, and the two are often
 * deliberately different.
 */
export const gstinVerificationResponse=z.object({
 gstin:z.string().length(15),
 legal_name:z.string().trim().max(200),
 trade_name:z.string().trim().max(200).nullable(),
 // The taxpayer's own GST registration status -- distinct from this call's
 // own outcome (route-level `status`: VERIFIED/UNAVAILABLE/NOT_CONFIGURED),
 // so the two are never spread into the same field.
 registration_status:z.enum(['ACTIVE','CANCELLED','SUSPENDED','PROVISIONAL']),
 registration_date:z.string().nullable(),
 state:z.string().trim().max(100).nullable(),
 constitution:z.string().trim().max(100).nullable(),
});
