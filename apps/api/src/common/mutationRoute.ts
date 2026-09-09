import {writeAudit} from "./audit.js";
import {inTransaction} from './transactionContext.js';
import {createHash} from 'node:crypto';
import type {FastifyRequest,FastifyReply} from 'fastify';
import type {Pool} from 'pg';
import {ApiError} from '@silverline/shared';
import {idempotencyKeyOf} from './idempotency.js';
/** Keep response, receipt and domain changes in one commit before sending a success. */
export async function mutationRoute(pool:Pool,req:FastifyRequest,reply:FastifyReply,handler:(db:Pool,reply:FastifyReply)=>Promise<unknown>):Promise<FastifyReply>{
 const db=await pool.connect(),key=idempotencyKeyOf(req),user=req.authUser?.id,hash=createHash('sha256').update(JSON.stringify([req.method,req.url,req.body??null])).digest('hex');
 let payload:unknown,hasPayload=false;
 const capture=new Proxy(reply,{get(target,property){
  if(property==='send')return (body:unknown)=>{payload=body;hasPayload=true;return undefined;};
  if(property==='then')return undefined;
  const value=Reflect.get(target,property);
  if(typeof value!=='function')return value;
  return (...args:unknown[])=>{const result=value.apply(target,args);return result===target?capture:result;};
 }}) as FastifyReply;
 try{
  await db.query('BEGIN');
  if(key&&user){
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${key}`]);
   const old=(await db.query('SELECT * FROM idempotency_keys WHERE user_id=$1 AND key=$2',[user,key])).rows[0];
   if(old){if(old.method!==req.method||old.path!==req.url.split('?')[0]||(old.request_hash&&old.request_hash!==hash))throw new ApiError({status:409,code:'IDEMPOTENCY_MISMATCH',message:'This retry key was already used for different request content'});await db.query('COMMIT');if(req.url==='/api/v1/attendance/events'&&old.status_code!==202)return reply.code(200).send({...old.response_body,applied:true});if(req.url==='/api/v1/leave/requests')return reply.code(200).send({applied:true,request:old.response_body});return reply.code(old.status_code).send(old.response_body);}
  }
  const result=await inTransaction(pool,db,()=>handler(db as unknown as Pool,capture));
  if(!hasPayload)payload=result;
  if(reply.statusCode>=400)await db.query('ROLLBACK');
  else {
   if(user&&['/api/v1/attendance/events','/api/v1/attendance/exceptions','/api/v1/attendance/regularize'].includes(req.url)){
    const body=payload as Record<string,any>;
    await writeAudit(db,{orgId:req.authUser!.orgId,actorId:user,action:req.url.endsWith('/events')?'attendance.punch':'attendance.exception.submit',entityType:req.url.endsWith('/events')?'attendance_event':'attendance_exception',entityId:body?.event?.id??body?.id??body?.exception_id??null,afterState:payload,requestId:req.requestId,idempotencyKey:key});
   }
   if(key&&user)await db.query('INSERT INTO idempotency_keys(key,user_id,method,path,status_code,response_body,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,key) DO UPDATE SET status_code=EXCLUDED.status_code,response_body=EXCLUDED.response_body,request_hash=EXCLUDED.request_hash',[key,user,req.method,req.url.split('?')[0],reply.statusCode,JSON.stringify(payload??null),hash]);
   await db.query('COMMIT');
  }
  return reply.send(payload);
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
