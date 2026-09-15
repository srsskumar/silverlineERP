import {resolveScopes} from '../../common/scopes.js';
import {scopedReads} from "../../common/scopedReads.js";
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { buildAuthenticate,requirePermission } from '../../common/auth.js';
import { actor,parse,page,projectAccess,fail,mutate,version } from '../../common/domain.js';

export async function registerAnalyticsRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}) {
 const {pool}=opts,auth=buildAuthenticate(opts),read=requirePermission(auth,'analytics.read');
 app.get('/api/v1/analytics/projects/:id',{preHandler:read},async req=>{
  const id=(req.params as {id:string}).id;await projectAccess(pool,req,id);const db=scopedReads(pool,pool,actor(req));
  const [summary,flow,cycles,workload,burndown]=await Promise.all([
   db.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status='DONE')::int AS completed,count(*) FILTER(WHERE status='BLOCKED')::int AS blocked,count(*) FILTER(WHERE planned_end_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND status NOT IN ('DONE','CANCELLED'))::int AS overdue,round(avg(extract(epoch FROM (actual_end_at-actual_start_at))/86400) FILTER(WHERE actual_end_at IS NOT NULL AND actual_start_at IS NOT NULL),2) AS cycle_time_days,round(avg(extract(epoch FROM (actual_end_at-created_at))/86400) FILTER(WHERE actual_end_at IS NOT NULL),2) AS lead_time_days FROM tasks WHERE project_id=$1",[id]),
   db.query("SELECT status,count(*)::int AS count,round(avg(extract(epoch FROM(now()-updated_at))/86400),2) AS average_age_days FROM tasks WHERE project_id=$1 GROUP BY status ORDER BY status",[id]),
   db.query("SELECT id,name,start_date,end_date,status,metrics FROM cycles WHERE project_id=$1 ORDER BY start_date LIMIT 100",[id]),
   db.query("SELECT t.assignee_id,u.username,COALESCE(NULLIF(trim(concat_ws(' ',e.first_name,e.last_name)),''),u.username) AS name,e.emp_no,count(*)::int AS open,count(*) FILTER(WHERE planned_end_date<(now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS overdue FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id LEFT JOIN employees e ON e.id=u.employee_id WHERE project_id=$1 AND t.status NOT IN ('DONE','CANCELLED') GROUP BY t.assignee_id,u.username,e.first_name,e.last_name,e.emp_no ORDER BY open DESC LIMIT 100",[id]),
   db.query("SELECT d::date::text AS date,count(t.id) FILTER(WHERE t.created_at<d+interval '1 day')::int AS created,count(t.id) FILTER(WHERE t.actual_end_at<d+interval '1 day')::int AS completed FROM generate_series(current_date-29,current_date,interval '1 day') d LEFT JOIN tasks t ON t.project_id=$1 GROUP BY d ORDER BY d",[id]),
  ]);
  return {generated_at:new Date().toISOString(),summary:summary.rows[0],flow:flow.rows,cycles:cycles.rows.map(c=>({...c,metrics:resolveScopes(actor(req).scopes).global||resolveScopes(actor(req).scopes).projects.includes(id)?c.metrics:null})),workload:workload.rows,burndown:burndown.rows};
 });
 app.get('/api/v1/insights/projects/:id',{preHandler:read},async req=>{
  const id=(req.params as {id:string}).id;await projectAccess(pool,req,id);const db=scopedReads(pool,pool,actor(req));
  const data=(await db.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE actual_end_at IS NOT NULL AND actual_start_at IS NOT NULL)::int AS samples,count(*) FILTER(WHERE status NOT IN ('DONE','CANCELLED'))::int AS open,count(*) FILTER(WHERE status='BLOCKED')::int AS blocked,count(*) FILTER(WHERE status NOT IN ('DONE','CANCELLED') AND planned_end_date<current_date)::int AS overdue,percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM(actual_end_at-actual_start_at))/86400) FILTER(WHERE actual_end_at IS NOT NULL AND actual_start_at IS NOT NULL) AS median_days FROM tasks WHERE project_id=$1",[id])).rows[0];
  const enough=data.samples>=5;
  return {model_version:'statistical-baseline-v1',prediction_timestamp:new Date().toISOString(),advisory:true,status:enough?'AVAILABLE':'INSUFFICIENT_DATA',sample_size:data.samples,confidence:enough?Math.min(0.85,0.4+data.samples/100):null,prediction:enough?{delay_risk:data.overdue>0||data.blocked>0?'HIGH':'LOW',typical_task_days:Math.round(Number(data.median_days)*10)/10}:null,factors:[{name:'Completed tasks with measured duration',value:data.samples},{name:'Overdue open tasks',value:data.overdue},{name:'Blocked tasks',value:data.blocked}],recommended_action:enough?(data.blocked?'Review blocked predecessors and rebalance workload.':'Compare remaining work with available team capacity.'):'Complete at least five tasks with recorded start and completion dates.'};
 });
 app.get('/api/v1/insights/projects/:id/workforce',{preHandler:read},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req);await projectAccess(pool,req,id);const db=scopedReads(pool,pool,u),q=parse(z.object({skill:z.string().trim().max(100).optional()}),req.query);
  const rows=(await db.query(`SELECT u.id,u.username,e.skills,count(t.id)::int AS visible_open_tasks,
   EXISTS(SELECT 1 FROM leave_requests l WHERE l.employee_id=e.id AND l.status='APPROVED' AND current_date BETWEEN l.from_date AND l.to_date) AS on_leave,
   CASE WHEN $2::text IS NULL THEN NULL ELSE e.skills ? $2 END AS skill_match
   FROM employees e JOIN users u ON u.employee_id=e.id LEFT JOIN tasks t ON t.assignee_id=u.id AND t.status NOT IN('DONE','CANCELLED')
   WHERE e.org_id=$1 AND e.status='ACTIVE' AND u.auth_status='ACTIVE' GROUP BY u.id,u.username,e.id,e.skills ORDER BY skill_match DESC NULLS LAST,visible_open_tasks,u.username LIMIT 50`,[u.orgId,q.skill??null])).rows;
  return {advisory:true,model_version:'workforce-rules-v1',prediction_timestamp:new Date().toISOString(),confidence:null,status:rows.length?'AVAILABLE':'INSUFFICIENT_DATA',scope_note:'Workload includes only tasks visible in your scope. Check availability and local travel requirements before assignment.',data:rows.map(r=>({...r,recommended_action:r.on_leave?'Unavailable on approved leave':r.skill_match===false?'Confirm skills before assignment':'Review workload and availability'}))};
 });
 app.get('/api/v1/insights/projects/:id/reviews',{preHandler:read},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),{limit,offset}=page(req);await projectAccess(pool,req,id);const db=scopedReads(pool,pool,u);
  const rows=(await db.query('SELECT c.* FROM advisory_cases c WHERE c.org_id=$1 AND c.project_id=$2 AND c.task_id IN(SELECT id FROM tasks) ORDER BY c.created_at DESC,c.id LIMIT $3 OFFSET $4',[u.orgId,id,limit+1,offset])).rows;
  return {data:rows.slice(0,limit),has_more:rows.length>limit};
 });
 app.post('/api/v1/insights/reviews/:id/decision',{preHandler:requirePermission(auth,'project.update')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),i=parse(z.object({status:z.enum(['CONFIRMED','DISMISSED']),reason:z.string().trim().min(1).max(2000)}),req.body);
  const row=(await pool.query('SELECT * FROM advisory_cases WHERE id=$1 AND org_id=$2',[id,u.orgId])).rows[0];if(!row)fail('NOT_FOUND','Review not found',404);await projectAccess(pool,req,row.project_id);
  return mutate(pool,req,'advisory.review','advisory_case',async db=>{const current=(await db.query('SELECT * FROM advisory_cases WHERE id=$1 FOR UPDATE',[id])).rows[0];version(req,current);if(current.status!=='OPEN')fail('REVIEW_CLOSED','Review is already closed',409);return (await db.query('UPDATE advisory_cases SET status=$2,reason=$3,reviewed_by=$4,reviewed_at=now(),version=version+1 WHERE id=$1 RETURNING *',[id,i.status,i.reason,u.id])).rows[0];});
 });
 app.post('/api/v1/insights/feedback',{preHandler:read},async(req,reply)=>{
  const i=parse(z.object({project_id:z.string().uuid(),model_version:z.literal('statistical-baseline-v1'),rating:z.enum(['CORRECT','INCORRECT','USEFUL','NOT_USEFUL']),reason:z.string().max(2000).optional()}),req.body),u=actor(req);await projectAccess(pool,req,i.project_id);
  const r=await mutate(pool,req,'insight.feedback','insight_feedback',async db=>(await db.query('INSERT INTO insight_feedback(org_id,project_id,model_version,rating,reason,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[u.orgId,i.project_id,i.model_version,i.rating,i.reason??null,u.id])).rows[0]);return reply.code(201).send(r);
 });
 app.get('/api/v1/search',{preHandler:auth},async req=>{
  const {q}=page(req),u=actor(req),query=(q.q??'').trim();if(query.length<2)return {data:[]};if(query.length>100)fail('VALIDATION_ERROR','Search is too long');
  const data=[];
  // Delegate to existing scope-aware lists, preserving each domain permission.
  for(const [kind,perm,path] of [['task','task.read','tasks'],['employee','employee.read','employees'],['project','project.read','projects']] as const){if(!u.permissions.includes(perm))continue;const r=await app.inject({method:'GET',url:`/api/v1/${path}?q=${encodeURIComponent(query)}&limit=10`,headers:{authorization:req.headers.authorization}});if(r.statusCode===200)for(const row of r.json().data??[])data.push({type:kind,id:row.id,title:row.title??row.name??`${row.first_name} ${row.last_name??''}`,project_id:row.project_id});}
  return {data};
 });
}
