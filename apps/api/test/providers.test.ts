import {afterEach,describe,it,expect} from 'vitest';
import {createServer,type Server} from 'node:net';
import {scanWithClamAv,scanUpload} from '../src/common/fileSafety.js';
import {callProvider,providerConfig} from '../src/modules/integrations/gateway.js';
import {runPushDelivery} from '../src/modules/jobs/push.js';
import type {Pool} from 'pg';
let server:Server|undefined;
afterEach(async()=>{if(server)await new Promise<void>(r=>server!.close(()=>r()));server=undefined;delete process.env.PUSH_ENABLED;});
describe('provider failure boundaries',()=>{
 it('uses ClamAV framed bytes and distinguishes clean, infected and unavailable scans',async()=>{
  for(const verdict of ['OK','Test.Signature FOUND','stream size limit exceeded. ERROR']){
   let received=Buffer.alloc(0),scanned=Buffer.alloc(0);server=createServer(socket=>socket.on('data',chunk=>{
    received=Buffer.concat([received,chunk]);if(received.length<10||received.subarray(0,10).toString()!=='zINSTREAM\0')return;
    let offset=10;const frames=[];while(received.length>=offset+4){const length=received.readUInt32BE(offset);offset+=4;if(!length){scanned=Buffer.concat(frames);socket.end(`stream: ${verdict}\0`);return;}if(received.length<offset+length)return;frames.push(received.subarray(offset,offset+length));offset+=length;}
   }));await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const address=server.address() as {port:number},bytes=Buffer.alloc(100000,65);
   const result=scanWithClamAv(bytes,'127.0.0.1',address.port);
   if(verdict==='OK')await expect(result).resolves.toBeUndefined();else await expect(result).rejects.toMatchObject({code:verdict.includes('FOUND')?'UNSAFE_FILE':'SCAN_UNAVAILABLE'});
   expect(scanned.equals(bytes)).toBe(true);await new Promise<void>(r=>server!.close(()=>r()));server=undefined;
  }
 });
 it('fails closed if production upload scanning is not configured',async()=>{
  const original=process.env.MALWARE_SCANNER_HOST;delete process.env.MALWARE_SCANNER_HOST;
  try{await expect(scanUpload(Buffer.from('%PDF-1.4'),'pdf',true)).rejects.toMatchObject({code:'SCAN_UNAVAILABLE'});}finally{if(original)process.env.MALWARE_SCANNER_HOST=original;}
 });
 it('keeps notification data generic and records the provider ticket before receipt polling',async()=>{
  process.env.PUSH_ENABLED='true';const updates:unknown[][]=[],requests:{url:string;body:any}[]=[];
  const rows=[{id:'delivery',device_id:'device',notification_id:'notice',push_token:'ExponentPushToken[test]',entity_type:'task',entity_id:'task',status:'PENDING',attempts:0,provider_id:null}];
  const pool={query:async(sql:string,values:unknown[]=[])=>{if(sql.startsWith('SELECT'))return {rows};if(sql.startsWith('UPDATE'))updates.push(values);return {rows:[]};}} as unknown as Pool;
  await runPushDelivery(pool,async(url,options)=>{requests.push({url:String(url),body:JSON.parse(String(options?.body))});return new Response(JSON.stringify({data:{status:'ok',id:'ticket'}}),{status:200});});
  expect(requests[0].url).toBe('https://exp.host/--/api/v2/push/send');expect(requests[0].body.body).toBe('Open the app to review your latest update.');expect(Object.keys(requests[0].body.data)).toEqual(['notificationId','entityType','entityId']);expect(updates[0].slice(0,4)).toEqual(['delivery','ACCEPTED',null,'ticket']);
 });
 it('invalidates a push token rejected by the receipt provider',async()=>{
  process.env.PUSH_ENABLED='true';const updates:{sql:string;values:unknown[]}[]=[];
  const pool={query:async(sql:string,values:unknown[]=[])=>{if(sql.startsWith('SELECT'))return {rows:[{id:'delivery',device_id:'device',push_token:'ExpoPushToken[test]',status:'ACCEPTED',attempts:1,provider_id:'ticket'}]};if(sql.startsWith('UPDATE'))updates.push({sql,values});return {rows:[]};}} as unknown as Pool;
  await runPushDelivery(pool,async()=>new Response(JSON.stringify({data:{ticket:{status:'error',details:{error:'DeviceNotRegistered'}}}}),{status:200}));
  expect(updates.some(u=>u.sql.includes('push_token=NULL'))).toBe(true);expect(updates.at(-1)?.values[1]).toBe('FAILED');
 });
});

describe('configurable integration gateway',()=>{
 it('stays disabled without configuration and rejects insecure destinations',async()=>{
  const old={...process.env};try{delete process.env.PROVIDER_WEATHER_ENABLED;expect(providerConfig('WEATHER').enabled).toBe(false);await expect(callProvider('WEATHER',{},'key',async()=>{throw new Error('must not send');})).rejects.toMatchObject({code:'PROVIDER_NOT_CONFIGURED'});process.env.PROVIDER_WEATHER_ENABLED='true';process.env.PROVIDER_WEATHER_TOKEN='test';process.env.PROVIDER_WEATHER_URL='http://localhost';expect(providerConfig('WEATHER').enabled).toBe(false);}finally{process.env=old;}
 });
 it('sends a stable idempotency key and classifies provider failures without exposing response contents',async()=>{
  const old={...process.env};try{Object.assign(process.env,{PROVIDER_ACCOUNTING_ENABLED:'true',PROVIDER_ACCOUNTING_TOKEN:'test-only',PROVIDER_ACCOUNTING_URL:'https://adapter.example.test/accounting'});
   const request:RequestInit[]=[];const result=await callProvider('ACCOUNTING',{invoices:[]},'stable-key',async(_url,init)=>{request.push(init!);return new Response(JSON.stringify({accepted:true,delivered:true,id:'receipt'}));});expect(result.id).toBe('receipt');expect((request[0].headers as Record<string,string>)['idempotency-key']).toBe('stable-key');expect(request[0].redirect).toBe('error');
   await expect(callProvider('ACCOUNTING',{},'key',async()=>new Response('private vendor data',{status:429}))).rejects.toMatchObject({code:'HTTP_429',retryable:true});
   await expect(callProvider('ACCOUNTING',{},'key',async()=>new Response('private vendor data',{status:400}))).rejects.toMatchObject({code:'HTTP_400',retryable:false});
   await expect(callProvider('ACCOUNTING',{},'key',async()=>new Response('not JSON'))).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE',retryable:false});
  }finally{process.env=old;}
 });
});
