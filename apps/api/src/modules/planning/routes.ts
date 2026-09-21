import {scopedReads} from '../../common/scopedReads.js';
import {effectiveCustomFields,validateCustomFields} from "../../common/customFields.js";
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { cycleSchema,customFieldSchema,taskWorkflowSchema,defaultTaskWorkflow, projectTypeSchema} from '@silverline/shared';
import { buildAuthenticate,requirePermission,scopesForPermission } from '../../common/auth.js';
import { actor,parse,page,inOrg,mutate,version,fail,projectAccess } from '../../common/domain.js';
import { resolveScopes,taskScopeClause,employeeScopeClause } from '../../common/scopes.js';

export async function registerPlanningRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}) {
 const {pool}=opts,auth=buildAuthenticate(opts),guard=(p:string)=>requirePermission(auth,p);
 async function fullProject(req:FastifyRequest,id:string){const scope=resolveScopes(actor(req).scopes);if(!scope.global&&!scope.projects.includes(id))fail('FORBIDDEN','This change requires permission for the whole project',403);await projectAccess(pool,req,id);}
 app.get('/api/v1/projects/:id/workflow',{preHandler:guard('project.read')},async req=>{
  const id=(req.params as {id:string}).id;await projectAccess(pool,req,id);
  const own=(await pool.query('SELECT * FROM project_workflow_overrides WHERE project_id=$1',[id])).rows[0];if(own)return own;
  const inherited=(await pool.query('SELECT w.statuses,w.allowed_transitions FROM projects p JOIN project_workflows w ON w.project_type_id=p.project_type_id WHERE p.id=$1',[id])).rows[0];return {...(inherited??defaultTaskWorkflow()),version:0,project_id:id};
 });
 app.put('/api/v1/projects/:id/workflow',{preHandler:guard('board.manage')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),i=parse(taskWorkflowSchema,req.body);await projectAccess(pool,req,id);
  const statuses=new Set(i.statuses);
  if(statuses.size!==i.statuses.length||statuses.size>30||['TO_DO','DONE','CANCELLED'].some(s=>!statuses.has(s)))fail('INVALID_WORKFLOW','Include TO_DO, DONE and CANCELLED exactly once, with up to 30 statuses');
  for(const [from,next] of Object.entries(i.allowed_transitions))if(!statuses.has(from)||next.some(to=>!statuses.has(to)||to===from)||(['DONE','CANCELLED'].includes(from)&&next.length))fail('INVALID_WORKFLOW','Edges must connect distinct configured statuses; terminal statuses cannot have outgoing edges');
  return mutate(pool,req,'project.workflow','project',async db=>{
   await inOrg(db,'projects',id,u.orgId,true);
   const current=(await db.query('SELECT version FROM project_workflow_overrides WHERE project_id=$1 FOR UPDATE',[id])).rows[0]??{version:0};
   if(req.headers['if-match']!==String(current.version))fail('VERSION_CONFLICT','Workflow changed. Reload before editing',409);
   // An archived board (083) is out of use: its columns no longer hold a status in place.
   const used=await db.query('SELECT DISTINCT status FROM tasks WHERE project_id=$1 UNION SELECT c.status_code AS status FROM board_columns c JOIN boards b ON b.id=c.board_id WHERE b.project_id=$1 AND b.archived_at IS NULL',[id]);
   if(used.rows.some(r=>!statuses.has(r.status)))fail('WORKFLOW_IN_USE','Keep statuses used by existing tasks or board columns',409);
   return (await db.query('INSERT INTO project_workflow_overrides(project_id,statuses,allowed_transitions,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET statuses=EXCLUDED.statuses,allowed_transitions=EXCLUDED.allowed_transitions,version=project_workflow_overrides.version+1,updated_at=now(),updated_by=EXCLUDED.updated_by RETURNING project_id AS id,project_id,statuses,allowed_transitions,version',[id,JSON.stringify(i.statuses),JSON.stringify(i.allowed_transitions),u.id])).rows[0];
  });
 });
 /**
  * Create a project type.
  *
  * Gated on project.create rather than admin.configure: the point of the
  * button is that somebody filling in a project, lead or tender form can add
  * the type they need without leaving it. Requiring an administrator meant
  * they picked the nearest wrong option instead, which is how a master list
  * stops meaning anything.
  *
  * The code is derived from the name. Asking a person typing "Turnkey" to also
  * invent a key for it is how one type lands in the master twice.
  */
 app.post('/api/v1/project-types',{preHandler:guard('project.create')},async(req,reply)=>{
  const u=actor(req),i=parse(projectTypeSchema,req.body);
  const result=await mutate(pool,req,'project_type.create','project_type',async db=>{
   const existing=(await db.query('SELECT * FROM project_types WHERE org_id=$1 AND code=$2',[u.orgId,i.code])).rows[0];
   // The caller is a person filling in a form; "AMC already exists" with no
   // way forward is a worse answer than simply using the one that does.
   if(existing) return {...existing,already_existed:true};
   const type=(await db.query('INSERT INTO project_types(org_id,code,name) VALUES($1,$2,$3) RETURNING *',[u.orgId,i.code,i.name])).rows[0];
   const workflow=defaultTaskWorkflow();
   // A type with no workflow has no statuses its tasks may move between, so
   // the first task raised against it would be stuck immediately.
   await db.query('INSERT INTO project_workflows(project_type_id,statuses,allowed_transitions) VALUES($1,$2,$3)',[type.id,JSON.stringify(workflow.statuses),JSON.stringify(workflow.allowed_transitions)]);
   return type;
  });
  // The bare row, as this endpoint has always returned. Changing the envelope
  // was not part of the request and would break its existing callers.
  return reply.code(result.already_existed?200:201).send(result);
 });
 const slaSchema=z.object({at_risk_days:z.number().int().min(0).max(90),team_lead_after_days:z.number().int().min(0).max(365),project_manager_after_days:z.number().int().min(0).max(365),super_admin_after_days:z.number().int().min(0).max(365)}).refine(v=>v.team_lead_after_days<=v.project_manager_after_days&&v.project_manager_after_days<=v.super_admin_after_days,'Escalation delays must follow TL, PM, Super Admin order');
 app.get('/api/v1/projects/:id/sla-policy',{preHandler:guard('project.read')},async req=>{const id=(req.params as {id:string}).id;await projectAccess(pool,req,id);const p=(await pool.query('SELECT p.version,p.sla_policy,pt.sla_policy AS inherited,p.project_type_id FROM projects p LEFT JOIN project_types pt ON pt.id=p.project_type_id WHERE p.id=$1',[id])).rows[0];return {version:p.version,project_type_id:p.project_type_id,inherited:p.sla_policy===null,policy:p.sla_policy??p.inherited??{at_risk_days:2,team_lead_after_days:0,project_manager_after_days:1,super_admin_after_days:3}};});
 app.put('/api/v1/projects/:id/sla-policy',{preHandler:guard('project.update')},async req=>{const id=(req.params as {id:string}).id,u=actor(req),i=parse(z.object({policy:slaSchema,apply_to_type:z.boolean().default(false)}),req.body);await projectAccess(pool,req,id);if(i.apply_to_type&&!resolveScopes(u.scopes).global)fail('FORBIDDEN','Project-type policies require organization-wide permission',403);return mutate(pool,req,'project.sla_policy','project',async db=>{const p=await inOrg(db,'projects',id,u.orgId,true);version(req,p as {version:number});if(i.apply_to_type){if(!p.project_type_id)fail('PROJECT_TYPE_REQUIRED','Choose a project type first');await db.query('UPDATE project_types SET sla_policy=$2 WHERE id=$1',[p.project_type_id,JSON.stringify(i.policy)]);}return (await db.query('UPDATE projects SET sla_policy=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,version,sla_policy',[id,i.apply_to_type?null:JSON.stringify(i.policy)])).rows[0];});});
 app.get('/api/v1/projects/:id/people',{preHandler:guard('task.read')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),{limit,offset,q}=page(req);await projectAccess(pool,req,id);
  const values:unknown[]=[u.orgId],scope=resolveScopes(u.scopes),clause=scope.global?'TRUE':await employeeScopeClause(pool,u.orgId,scope,values);
  const textIndex=values.push(`%${q.q??''}%`),limitIndex=values.push(limit+1),offsetIndex=values.push(offset);
  const rows=(await pool.query(`SELECT u.id,u.username FROM users u WHERE u.org_id=$1 AND u.auth_status='ACTIVE' AND (u.employee_id IS NULL OR u.employee_id IN(SELECT id FROM employees WHERE status='ACTIVE' AND ${clause})) AND u.username ILIKE $${textIndex} ORDER BY u.username,u.id LIMIT $${limitIndex} OFFSET $${offsetIndex}`,values)).rows;
  return {data:rows.slice(0,limit),has_more:rows.length>limit};
 });
 app.get('/api/v1/projects/:id/dependencies',{preHandler:guard('task.read')},async req=>{const id=(req.params as {id:string}).id;await projectAccess(pool,req,id);return {data:(await scopedReads(pool,pool,actor(req)).query('SELECT d.predecessor_id,d.successor_id FROM task_dependencies d JOIN tasks t ON t.id=d.successor_id JOIN tasks predecessor ON predecessor.id=d.predecessor_id WHERE t.org_id=$1 AND t.project_id=$2 ORDER BY d.predecessor_id,d.successor_id LIMIT 1000',[actor(req).orgId,id])).rows};});

 async function taskAccess(req:FastifyRequest,id:string,write=false){
  const u=actor(req),task=await inOrg(pool,'tasks',id,u.orgId);await projectAccess(pool,req,task.project_id);
  const scopes=resolveScopes(u.scopes);if(!scopes.global){const values:unknown[]=[id,u.orgId],clause=await taskScopeClause(pool,u.orgId,scopes,values);if(!(await pool.query(`SELECT 1 FROM tasks WHERE id=$1 AND org_id=$2 AND ${clause}`,values)).rowCount)fail('FORBIDDEN','Task is outside your scope',403);}
  if(write&&!u.permissions.includes('task.assign')&&task.assignee_id!==u.id)fail('FORBIDDEN','Only your assigned tasks can be edited',403);
  return task;
 }
 app.get('/api/v1/cycles',{preHandler:guard('cycle.read')},async req=>{
  const {limit,offset,q}=page(req);if(!q.project_id)fail('PROJECT_REQUIRED','Choose a project');await projectAccess(pool,req,q.project_id);
  const r=await pool.query('SELECT * FROM cycles WHERE org_id=$1 AND project_id=$2 ORDER BY start_date DESC,id LIMIT $3 OFFSET $4',[actor(req).orgId,q.project_id,limit+1,offset]);return {data:r.rows.slice(0,limit),has_more:r.rows.length>limit};
 });
 app.post('/api/v1/cycles',{preHandler:guard('cycle.manage')},async(req,reply)=>{
  const i=parse(cycleSchema,req.body),u=actor(req);await fullProject(req,i.project_id);
  const row=await mutate(pool,req,'cycle.create','cycle',async db=>{
   const p=await inOrg(db,'projects',i.project_id,u.orgId,true);if(['CLOSED','CANCELLED'].includes(p.status))fail('PROJECT_INACTIVE','Project is closed');
   const overlap=await db.query("SELECT 1 FROM cycles WHERE project_id=$1 AND status<>'CLOSED' AND daterange(start_date,end_date,'[]') && daterange($2::date,$3::date,'[]')",[i.project_id,i.start_date,i.end_date]);if(overlap.rowCount)fail('CYCLE_OVERLAP','Cycle dates overlap an existing iteration',409);
   return (await db.query('INSERT INTO cycles(org_id,project_id,name,start_date,end_date,goal,rollover,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[u.orgId,i.project_id,i.name,i.start_date,i.end_date,i.goal??null,i.rollover,u.id])).rows[0];
  });return reply.code(201).send(row);
 });
 app.post('/api/v1/cycles/:id/start',{preHandler:guard('cycle.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,row=await inOrg(pool,'cycles',id,u.orgId);await fullProject(req,row.project_id);
  return mutate(pool,req,'cycle.start','cycle',async db=>{const c=await inOrg(db,'cycles',id,u.orgId,true);version(req,c as {version:number});if(c.status!=='PLANNED')fail('INVALID_TRANSITION','Only a planned cycle can start',409);return (await db.query("UPDATE cycles SET status='ACTIVE',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];});
 });
 app.post('/api/v1/cycles/:id/close',{preHandler:guard('cycle.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,row=await inOrg(pool,'cycles',id,u.orgId);await fullProject(req,row.project_id);
  return mutate(pool,req,'cycle.close','cycle',async db=>{
   await inOrg(db,'projects',row.project_id,u.orgId,true);
   const c=await inOrg(db,'cycles',id,u.orgId,true);version(req,c as {version:number});if(c.status==='CLOSED')fail('CYCLE_CLOSED','Cycle already closed',409);
   await inOrg(db,'projects',c.project_id,u.orgId,true);
   const metrics=(await db.query("SELECT count(*)::int AS planned,count(*) FILTER(WHERE status='DONE')::int AS completed,count(*) FILTER(WHERE status NOT IN ('DONE','CANCELLED'))::int AS remaining FROM tasks WHERE cycle_id=$1",[id])).rows[0];
   let next:string|null=null;
   if(c.rollover==='NEXT'&&metrics.remaining>0){
    const existing=await db.query("SELECT id FROM cycles WHERE project_id=$1 AND start_date>$2 AND status<>'CLOSED' ORDER BY start_date LIMIT 1",[c.project_id,c.end_date]);
    next=existing.rows[0]?.id??(await db.query("INSERT INTO cycles(org_id,project_id,name,start_date,end_date,rollover,created_by) VALUES($1,$2,$3,$4::date+1,$4::date+1+($4::date-$5::date),$6,$7) RETURNING id",[u.orgId,c.project_id,`${c.name} — next`,c.end_date,c.start_date,c.rollover,u.id])).rows[0].id;
   }
   await db.query("UPDATE tasks SET cycle_id=$2,version=version+1,updated_at=now(),updated_by=$3 WHERE cycle_id=$1 AND status NOT IN ('DONE','CANCELLED')",[id,next,u.id]);
   return (await db.query("UPDATE cycles SET status='CLOSED',closed_at=now(),metrics=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id,JSON.stringify({...metrics,next_cycle_id:next})])).rows[0];
  });
 });
 app.get('/api/v1/custom-fields',{preHandler:guard('task.read')},async req=>{const {q}=page(req);if(!q.project_id)fail('PROJECT_REQUIRED','Choose a project');await projectAccess(pool,req,q.project_id);return {data:await effectiveCustomFields(pool,q.project_id)};});
 app.post('/api/v1/custom-fields',{preHandler:guard('custom_field.manage')},async(req,reply)=>{
  const i=parse(customFieldSchema,req.body),u=actor(req);if(i.project_id)await projectAccess(pool,req,i.project_id);else {if(!resolveScopes(await scopesForPermission(req,'custom_field.manage')).global)fail('FORBIDDEN','Project-type fields require organization-wide permission',403);if(!(await pool.query('SELECT 1 FROM project_types WHERE id=$1 AND org_id=$2',[i.project_type_id,u.orgId])).rowCount)fail('NOT_FOUND','Project type not found',404);}
  const r=await mutate(pool,req,'custom_field.create','custom_field',async db=>(await db.query('INSERT INTO custom_field_definitions(org_id,project_id,field_key,name,field_type,options,required,created_by,project_type_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[u.orgId,i.project_id??null,i.field_key,i.name,i.field_type,JSON.stringify(i.options),i.required,u.id,i.project_type_id??null])).rows[0]);return reply.code(201).send(r);
 });
 app.patch('/api/v1/custom-fields/:id',{preHandler:guard('custom_field.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,i=parse(z.object({active:z.boolean()}),req.body),old=await inOrg(pool,'custom_field_definitions',id,u.orgId);if(old.project_id)await projectAccess(pool,req,old.project_id);else if(!resolveScopes(u.scopes).global)fail('FORBIDDEN','Project-type fields require organization-wide permission',403);
  return mutate(pool,req,'custom_field.update','custom_field',async db=>{const row=await inOrg(db,'custom_field_definitions',id,u.orgId,true);version(req,row as {version:number});return (await db.query('UPDATE custom_field_definitions SET active=$2,version=version+1 WHERE id=$1 RETURNING *',[id,i.active])).rows[0];});
 });
 app.get('/api/v1/tasks/:id/planning',{preHandler:guard('task.read')},async req=>{const row=await taskAccess(req,(req.params as {id:string}).id);return {id:row.id,version:row.version,cycle_id:row.cycle_id,custom_fields:row.custom_fields,checklist:row.checklist,actual_start_at:row.actual_start_at,actual_end_at:row.actual_end_at};});
 app.patch('/api/v1/tasks/:id/planning',{preHandler:guard('task.update')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),snapshot=await taskAccess(req,id,true);
  const i=parse(z.object({cycle_id:z.string().uuid().nullable().optional(),custom_fields:z.record(z.unknown()).optional(),checklist:z.array(z.object({id:z.string().uuid(),title:z.string().trim().min(1).max(500),done:z.boolean()})).max(100).optional()}),req.body);
  return mutate(pool,req,'task.planning','task',async db=>{
   await inOrg(db,'projects',snapshot.project_id,u.orgId,true);
   const task=await inOrg(db,'tasks',id,u.orgId,true);version(req,task as {version:number});
   if(i.cycle_id){const c=await inOrg(db,'cycles',i.cycle_id,u.orgId,true);if(c.project_id!==task.project_id||c.status==='CLOSED')fail('INVALID_CYCLE','Select an open cycle in this project');}
   const fields=i.custom_fields??task.custom_fields;
   const allowed=await validateCustomFields(db,task.project_id,u.orgId,fields);
   if(i.custom_fields && Object.keys(fields).some(k=>!allowed.has(k)&&JSON.stringify(fields[k])!==JSON.stringify(task.custom_fields[k])))fail('UNKNOWN_CUSTOM_FIELD','Field is not defined for this project');
   return (await db.query('UPDATE tasks SET cycle_id=$2,custom_fields=$3,checklist=$4,version=version+1,updated_at=now(),updated_by=$5 WHERE id=$1 RETURNING id,project_id,version,cycle_id,custom_fields,checklist',[id,i.cycle_id===undefined?task.cycle_id:i.cycle_id,JSON.stringify(fields),JSON.stringify(i.checklist??task.checklist),u.id])).rows[0];
  });
 });
 app.get('/api/v1/projects/:id/activity',{preHandler:guard('project.read')},async req=>{
  const id=(req.params as {id:string}).id,{limit,offset}=page(req);await projectAccess(pool,req,id);
  return {data:(await pool.query("SELECT id,type,entity_type,entity_id,actor_id,created_at FROM domain_events WHERE org_id=$1 AND (entity_id=$2 OR payload->>'project_id'=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4",[actor(req).orgId,id,limit,offset])).rows};
 });
 app.get('/api/v1/tasks/:id/activity',{preHandler:guard('task.read')},async req=>{const id=(req.params as {id:string}).id;await taskAccess(req,id);return {data:(await pool.query('SELECT id,type,actor_id,created_at FROM domain_events WHERE org_id=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 100',[actor(req).orgId,id])).rows};});
 // Bulk actions reuse the same authenticated mutation routes and return each outcome.
 app.post('/api/v1/tasks/bulk',{preHandler:guard('task.update')},async(req,reply)=>{
  const i=parse(z.object({tasks:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive()})).min(1).max(50),action:z.enum(['status','assign','label']),value:z.string().min(1).max(100),reason:z.string().min(1).max(1000).optional()}),req.body);
  const results=[];for(const t of i.tasks){const url=i.action==='status'?`/api/v1/tasks/${t.id}/status`:i.action==='assign'?`/api/v1/tasks/${t.id}/assign`:`/api/v1/tasks/${t.id}/labels`;
   const response=await app.inject({method:i.action==='status'?'PATCH':'POST',url,headers:{authorization:req.headers.authorization,'if-match':String(t.version),'idempotency-key':`${String(req.headers['idempotency-key']??req.requestId)}:${t.id}`},payload:i.action==='status'?{status:i.value}:i.action==='assign'?{assignee_id:i.value,reason:i.reason}:{label_id:i.value}});results.push({id:t.id,status:response.statusCode,result:response.json()});}
  return reply.code(207).send({data:results});
 });
}
