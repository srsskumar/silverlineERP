/// <reference types="node" />
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createQueue,type QueueDatabase} from '../src/sync/queueCore';
import {SCHEMA_SQL,RECOVER_INTERRUPTED_SQL} from '../src/sync/schema';
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(SCHEMA_SQL);let account='alice';const keys=new Map<string,Buffer>();
 const key=(id:string)=>{if(!keys.has(id))keys.set(id,randomBytes(32));return keys.get(id)!;};
 const port:QueueDatabase={getFirstAsync:async<T>(sql:string,params:(string|number|null)[])=>db.prepare(sql).get(...params) as T??null,getAllAsync:async<T>(sql:string,params:(string|number|null)[])=>db.prepare(sql).all(...params) as T[],runAsync:async(sql,params)=>db.prepare(sql).run(...params)};
 const queue=createQueue({getDb:async()=>port,getAccount:async()=>account,uuid:randomUUID,isApiError:(e):e is Error&{status:number;retryable:boolean;code:string}=>e instanceof Error&&'status' in e,
 seal:async(id,value)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(id),iv),data=Buffer.concat([c.update(value),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');},unseal:async(id,value)=>{const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key(id),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString();}});
 return {db,queue,switchAccount:(id:string)=>{account=id;}};
}
describe('SQLite outbox integration',()=>{
 it('encrypts payloads and reaches queued work after more than 50 historical rows',async()=>{const {db,queue}=fixture();for(let i=0;i<60;i++){await queue.enqueueOp({entity:'task_comment',op:String(i),payload:{body:'Private comment '+i}});}await queue.flushQueue(async()=>({status:201,body:{}}));const result=await queue.flushQueue(async()=>({status:201,body:{}}));assert.equal(result.succeeded,10);const row=db.prepare('SELECT payload FROM pending_ops LIMIT 1').get();assert.ok(!String(row?.payload).includes('Private'));db.close();});
 it('recovers interrupted sends and preserves the original retry key',async()=>{const {db,queue}=fixture(),op=await queue.enqueueOp({entity:'attendance_event',op:'in',payload:{kind:'CHECK_IN'}});db.prepare("UPDATE pending_ops SET state='SENDING'").run();db.exec(RECOVER_INTERRUPTED_SQL);let key='';await queue.flushQueue(async row=>{key=row.idempotency_key;return {status:200,body:{applied:true}};});assert.equal(key,op.idempotency_key);assert.equal(db.prepare('SELECT state FROM pending_ops').get()?.state,'SUCCEEDED');db.close();});
 it('deduplicates identical pending edits and retains distinct edits to the same record',async()=>{const {db,queue}=fixture(),a=await queue.enqueueOp({entity:'task_status',op:'task',payload:{status:'IN_PROGRESS'}}),b=await queue.enqueueOp({entity:'task_status',op:'task',payload:{status:'IN_PROGRESS'}}),c=await queue.enqueueOp({entity:'task_status',op:'task',payload:{status:'IN_REVIEW'}});assert.equal(a.client_uuid,b.client_uuid);assert.notEqual(a.client_uuid,c.client_uuid);db.close();});
 it('backs off a lost response and retries without a new identity',async()=>{const {db,queue}=fixture(),op=await queue.enqueueOp({entity:'task_comment',op:'comment',payload:{body:'Hello'}});await queue.flushQueue(async()=>{throw new Error('Connection lost');});assert.equal(db.prepare('SELECT state FROM pending_ops').get()?.state,'BACKOFF');db.prepare('UPDATE pending_ops SET next_retry_at=0').run();await queue.flushQueue(async row=>{assert.equal(row.idempotency_key,op.idempotency_key);return {status:200,body:{applied:true}};});assert.equal(db.prepare('SELECT state FROM pending_ops').get()?.state,'SUCCEEDED');db.close();});
 it('stops retrying conflicts and stops a flush when accounts change',async()=>{const {db,queue,switchAccount}=fixture();await queue.enqueueOp({entity:'task_status',op:'one',payload:{}});await queue.enqueueOp({entity:'task_status',op:'two',payload:{}});const result=await queue.flushQueue(async()=>{switchAccount('bob');return {status:409,body:{code:'VERSION_CONFLICT'}};});assert.equal(result.attempted,1);assert.equal(result.failed,1);assert.equal(db.prepare("SELECT count(*) AS n FROM pending_ops WHERE state='QUEUED'").get()?.n,1);db.close();});
});
