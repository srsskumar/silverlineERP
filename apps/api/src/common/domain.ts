import { createHash } from 'node:crypto';
import {inTransaction} from './transactionContext.js';
import {parseIfMatch} from './ifMatch.js';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError, toFieldErrors, validationSummary, fieldLabel } from '@silverline/shared';
import type { z } from 'zod';
import { resolveScopes, taskScopeClause, employeeScopeClause } from './scopes.js';

/**
 * Where a NUL byte is hiding in the body, if one is.
 *
 * Postgres will not store one in a text column: it comes back from the driver
 * as an error nobody asked for, which the handler turns into a 500 and a
 * stack trace in the log. What the caller needs instead is a sentence naming
 * the field. Nothing a person types produces a NUL — it arrives from a
 * corrupt export or from somebody trying it on — so refusing it and saying
 * which value it was in is the whole of the right behaviour.
 *
 * Every module validates through parse(), so this is the one place it needs
 * to be said.
 */
function nulByteIn(value:unknown,path:string[]=[],depth=0):string|null {
 if(depth>24) return null;
 if(typeof value==='string') return value.includes('\u0000')?(path.join('.')||'body'):null;
 if(Array.isArray(value)) {
  for(let i=0;i<value.length;i++) {
   const hit=nulByteIn(value[i],[...path,String(i)],depth+1);
   if(hit) return hit;
  }
  return null;
 }
 if(value&&typeof value==='object') {
  for(const [k,v] of Object.entries(value as Record<string,unknown>)) {
   const hit=nulByteIn(v,[...path,k],depth+1);
   if(hit) return hit;
  }
 }
 return null;
}

export function parse<T>(schema:z.ZodType<T, z.ZodTypeDef, unknown>,body:unknown):T {
 const nul=nulByteIn(body);
 if(nul) throw new ApiError({status:422,code:'VALIDATION_ERROR',message:'Validation failed',
  fieldErrors:[{field:nul,message:`${fieldLabel(nul)} contains a character that cannot be stored. It usually comes from a corrupt export — retype the value or re-export the file.`,code:'invalid_string'}]});
 const result=schema.safeParse(body);
 if(!result.success) {
  // The headline says the problem rather than the category. "Validation
  // failed" is what the server calls it, and tells whoever is looking at the
  // form nothing they can act on.
  const fieldErrors=toFieldErrors(result.error);
  throw new ApiError({status:422,code:'VALIDATION_ERROR',message:validationSummary(fieldErrors),fieldErrors});
 }
 return result.data;
}
export function fail(code:string,message:string,status=422):never {throw new ApiError({status,code,message});}
export function actor(req:FastifyRequest) {if(!req.authUser) fail('UNAUTHENTICATED','Sign in first',401);return req.authUser;}
export function version(req:FastifyRequest,row:{version:number},label?:string) {
 // Shared with the other seven modules so every route reads the header the
 // same way, weak validators and all. `label` names whose version is wanted
 // when that is not obvious from the URL alone -- an approval decision, for
 // instance, wants the approval instance's version, not the document's, and
 // a caller who already has the document's version in hand will reach for
 // that one first unless told otherwise.
 let n:number;
 try { n=parseIfMatch(req as unknown as {headers:Record<string,unknown>}); }
 catch { fail('VERSION_REQUIRED',label
   ? `If-Match must contain the current version of the ${label}, not the document it is about.`
   : 'If-Match must contain the current version'); }
 if(n!==row.version) fail('VERSION_CONFLICT',label
   ? `This ${label} changed — reload it (not the document it is about) before deciding again.`
   : 'This record changed. Reload before editing.',409);
}
export function page(req:FastifyRequest) {
 const q=req.query as Record<string,string>;
 const limit=Math.min(100,Math.max(1,Number(q.limit)||30));
 const offset=Math.max(0,Number(q.offset)||0);
 if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset)) fail('VALIDATION_ERROR','Invalid pagination');
 return {limit,offset,q};
}
export async function inOrg(db:Pool|PoolClient,table:string,id:string,orgId:string,lock=false):Promise<Record<string,any>> {
 // Interpolated straight into SQL below, so this allow-list is the injection
 // guard, not a convenience. Every table a route passes here must be named.
 const allowed=['vendors','inventory_items','invoices','assets','employees','projects','tasks','cycles','automation_rules','webhook_subscriptions','custom_field_definitions','users',
  // Commercial spine (§6.3-6.5, §8).
  'clients','contacts','leads','opportunities','tenders','private_proposals','bank_guarantee_instruments','workspaces','party_gst_registrations',
  // Running-account billing (§15).
  'boq_items','ra_bills','project_advances',
  // Approvals (§41).
  'approval_policies','approval_instances','approval_delegations',
  // Procurement (§13).
  'purchase_requisitions','purchase_orders','goods_receipt_notes',
  // §43 enhancements.
  'rfqs','vendor_quotes','vendor_returns',
  // Expenses and project cost control (§15.6, §16).
  'cost_heads','expense_policies','expense_claims',
  // A locked payroll run, read when its wage bill is apportioned onto the
  // projects the days were worked on (§note 10).
  'payroll_runs',
  // Financial control (§45).
  'financial_periods','payments','bank_transactions',
  // Inventory control (§44).
  'stock_locations','stock_reservations','stock_counts',
  // Workforce allocation (§47).
  'resource_allocations','work_shifts','roster_entries',
  // Project masters (§6.2).
  'project_categories','project_types',
  // Payables and receivables (§58).
  'payment_runs','documents','document_types',
  'survey_projects','survey_villages','survey_entries','survey_measures','survey_stages',
  // Allocations, so one can be corrected by id (§note 4).
  'survey_rover_allocations','survey_crew',
  // Amending a billing claim by id (§066).
  'survey_village_billing',
  // Correcting one control point by id (§069).
  'survey_village_gcps',
  // §073: questions raised on the status, the contact list on both sides, and
  // where the alerts go.
  'survey_queries','survey_contacts','survey_alert_subscriptions',
  // The geography a contact covers or a question is asked about (§073, §074).
  'org_units',
  // Correcting one allocation by id (§note 6).
  'asset_assignments'];
 // The allow-list is the injection guard for the interpolated table name
 // below, not a convenience — every table a route passes here must be named.
 // Naming the table in the error turns a bare 500 into a one-line fix; this
 // has cost several debugging sessions.
 if(!allowed.includes(table)) throw new Error(`inOrg: '${table}' is not in the allowed table list in common/domain.ts`);
 const r=await db.query(`SELECT * FROM ${table} WHERE id=$1 AND org_id=$2${lock?' FOR UPDATE':''}`,[id,orgId]);
 if(!r.rowCount) fail('NOT_FOUND',
  'That record no longer exists, or it belongs to something you do not have access to. Go back to the list and open it from there.',404);
 return r.rows[0];
}
export async function projectAccess(pool:Pool,req:FastifyRequest,id:string) {
 const u=actor(req);await inOrg(pool,'projects',id,u.orgId);
 const scopes=resolveScopes(u.scopes);
 if(scopes.global||scopes.projects.includes(id)) return;
 const values:unknown[]=[id,u.orgId];
 const clause=await taskScopeClause(pool,u.orgId,scopes,values);
 const r=await pool.query(`SELECT 1 FROM tasks WHERE project_id=$1 AND org_id=$2 AND ${clause} LIMIT 1`,values);
 if(!r.rowCount) fail('FORBIDDEN','Project outside your scope',403);
}
export async function employeeAccess(pool:Pool,req:FastifyRequest,id:string) {
 const u=actor(req),scopes=resolveScopes(u.scopes);if(scopes.global)return;
 const values:unknown[]=[id,u.orgId],clause=await employeeScopeClause(pool,u.orgId,scopes,values);
 const r=await pool.query(`SELECT 1 FROM employees WHERE id=$1 AND org_id=$2 AND ${clause}`,values);
 if(!r.rowCount)fail('FORBIDDEN','Employee outside your scope',403);
}
/** Serialize matching retries; commit business mutation, receipt, audit and event atomically. */
export async function mutate<T>(pool:Pool,req:FastifyRequest,action:string,entity:string,fn:(db:PoolClient)=>Promise<T>):Promise<T> {
 const u=actor(req),key=String(req.headers['idempotency-key']??'');
 if(key.length>255)fail('INVALID_IDEMPOTENCY_KEY','Idempotency key is too long');
 const hash=createHash('sha256').update(JSON.stringify({method:req.method,url:req.url,body:req.body??null})).digest('hex');
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  if(key){
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${u.id}:${key}`]);
   const prior=await db.query('SELECT * FROM v2_operations WHERE user_id=$1 AND key=$2',[u.id,key]);
   if(prior.rowCount){if(prior.rows[0].request_hash!==hash)fail('IDEMPOTENCY_CONFLICT','Key was already used for another request',409);await db.query('COMMIT');return prior.rows[0].response as T;}
  }
  const value=await inTransaction(pool,db,()=>fn(db));
  const object=value as Record<string,unknown>;
  const id=typeof object?.id==='string'?object.id:null;
  // Secrets and personal records are never copied into event payloads.
  const safe=entity==='user'||entity==='webhook'||entity==='settings'?{id}:value;
  /*
   * actor_id stays whoever the system believed was acting, so ownership and
   * every report already written against it keep working; impersonator_id
   * (§075) names who was actually at the keyboard, and is null for the
   * overwhelming majority of rows where those are the same person.
   */
  // req.ip is always present on a real request (Fastify sets it from the
  // socket, or from X-Forwarded-For under trustProxy); the ?? null guards
  // only a test double built without one, so a stub caller never crashes.
  const actorIp=req.ip??null;
  const ua=req.headers?.['user-agent'];
  const actorUserAgent=typeof ua==='string'?ua:null;
  await db.query('INSERT INTO audit_events(org_id,actor_id,actor_ip,actor_user_agent,action,entity_type,entity_id,after_state,request_id,idempotency_key,impersonator_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[u.orgId,u.id,actorIp,actorUserAgent,action,entity,id,JSON.stringify(safe),req.requestId,key||null,u.impersonator?.id??null]);
  if(key)await db.query('INSERT INTO v2_operations(key,user_id,path,request_hash,response) VALUES($1,$2,$3,$4,$5)',[key,u.id,req.url,hash,JSON.stringify(value)]);
  await db.query('COMMIT');return value;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
