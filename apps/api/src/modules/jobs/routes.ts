import {createRateLimiter} from '../../common/rateLimit.js';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {reportCreateSchema,REPORT_DOMAIN_READ} from '@silverline/shared';
import {buildAuthenticate,requirePermission} from '../../common/auth.js';
import {actor,parse,mutate,fail,page,version} from '../../common/domain.js';
import {runJobs} from '../automation/worker.js';
import {timingSafeEqual} from 'node:crypto';
export async function registerJobRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}){
 const auth=buildAuthenticate(opts),guard=requirePermission(auth,'report.generate'),{pool}=opts;
 app.get('/api/v1/report-schedules',{preHandler:guard},async req=>{const {limit,offset}=page(req),u=actor(req);const rows=(await pool.query('SELECT * FROM report_schedules WHERE org_id=$1 AND created_by=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',[u.orgId,u.id,limit+1,offset])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
 app.post('/api/v1/report-schedules',{preHandler:guard},async(req,reply)=>{
  const i=parse(reportCreateSchema.extend({name:z.string().trim().min(1).max(200),frequency:z.enum(['DAILY','WEEKLY','MONTHLY'])}),req.body),u=actor(req);
  if(!u.permissions.includes(REPORT_DOMAIN_READ[i.type]))fail('FORBIDDEN','This report type is unavailable',403);
  const row=await mutate(pool,req,'report.schedule','report_schedule',async db=>(await db.query('INSERT INTO report_schedules(org_id,name,report_type,format,filters,frequency,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[u.orgId,i.name,i.type,i.format,JSON.stringify(i.filters??{}),i.frequency,u.id])).rows[0]);return reply.code(201).send(row);
 });
 app.patch('/api/v1/report-schedules/:id',{preHandler:guard},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),i=parse(z.object({active:z.boolean()}),req.body);
  return mutate(pool,req,'report.schedule_update','report_schedule',async db=>{const old=(await db.query('SELECT * FROM report_schedules WHERE id=$1 AND org_id=$2 AND created_by=$3 FOR UPDATE',[id,u.orgId,u.id])).rows[0];if(!old)fail('NOT_FOUND','Schedule not found',404);version(req,old);return (await db.query('UPDATE report_schedules SET active=$2,failures=0,error=NULL,version=version+1 WHERE id=$1 RETURNING *',[id,i.active])).rows[0];});
 });
 app.get('/api/v1/reports',{preHandler:guard},async req=>{const {limit,offset}=page(req),u=actor(req),rows=(await pool.query("SELECT id,entry->>'type' AS type,entry->>'format' AS format,entry->>'status' AS status,entry->>'error' AS error,entry->>'rows' AS rows,entry->>'downloadUrl' AS download_url,created_at FROM report_registry WHERE org_id=$1 AND created_by=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4",[u.orgId,u.id,limit+1,offset])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
 app.post('/api/v1/client-errors',{preHandler:[auth,createRateLimiter({max:10,windowMs:60000})]},async req=>{
  const i=parse(z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),category:z.enum(['FATAL_JS','RENDER_JS']),platform:z.enum(['android','ios','web']),app_version:z.string().regex(/^[0-9.]{1,30}$/)}).strict(),req.body);
  return mutate(pool,req,'client.error','client_error',async()=>({...i,accepted:true}));
 });
 /**
  * One pass of the background worker.
  *
  * A serverless host cannot run the long-lived loop in jobs.ts, so the same
  * work is driven by a scheduler calling this endpoint (see apps/api/vercel.json
  * for the cron entry) and by an operator kicking it by hand.
  *
  * It is authorized by a shared secret rather than a user session: the caller
  * is a scheduler, not a person, and the work it triggers already runs under
  * each automation rule's own acting user. The comparison is constant-time —
  * a timing oracle on this secret would let an attacker drive the worker.
  */
 // Vercel's scheduler issues a GET; an operator kicking it by hand reaches for
 // POST. Both run the same pass.
 app.route({method:['GET','POST'],url:'/api/v1/jobs/run',handler:async(req,reply)=>{
  const expected=process.env.CRON_SECRET;
  if(!expected)return reply.code(503).send({code:'CRON_NOT_CONFIGURED',message:'Set CRON_SECRET to enable scheduled processing',field_errors:[],request_id:req.requestId,retryable:false});
  const header=req.headers.authorization??'';
  const presented=header.startsWith('Bearer ')?header.slice(7):'';
  const a=Buffer.from(presented),b=Buffer.from(expected);
  if(a.length!==b.length||!timingSafeEqual(a,b))return reply.code(401).send({code:'UNAUTHENTICATED',message:'Invalid cron credentials',field_errors:[],request_id:req.requestId,retryable:false});
  const started=Date.now();
  const result=await runJobs(app,pool,opts.jwtSecret);
  return reply.send({...result,duration_ms:Date.now()-started});
 }});

 app.get('/api/v1/auth/preferences',{preHandler:auth},async req=>(await pool.query('SELECT notification_preferences FROM users WHERE id=$1',[actor(req).id])).rows[0]);
 app.patch('/api/v1/auth/preferences',{preHandler:auth},async req=>{const i=parse(z.object({push:z.boolean().optional(),sms:z.boolean().optional(),whatsapp:z.boolean().optional()}).strict().refine(v=>Object.values(v).some(x=>x!==undefined),'Choose a preference'),req.body);return mutate(pool,req,'user.preferences','user',async db=>(await db.query('UPDATE users SET notification_preferences=notification_preferences||$2::jsonb WHERE id=$1 RETURNING id,notification_preferences',[actor(req).id,JSON.stringify(i)])).rows[0]);});
}
