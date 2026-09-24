import {scopesForPermission} from './auth.js';
import type {FastifyRequest} from 'fastify';
import {ApiError} from '@silverline/shared';
import {resolveScopes,employeeScopeClause,taskScopeClause} from './scopes.js';

/** Check record access after the endpoint permission, including child routes. */
export async function enforceRecordScope(req:FastifyRequest,permission:string):Promise<void>{
 const u=req.authUser;if(!u)return;const pool=req.server.db,scopes=resolveScopes(u.scopes),path=req.routeOptions.url??req.url,params=req.params as {id?:string;taskId?:string},body=(req.body??{}) as Record<string,unknown>;
 // The message is the whole of what somebody gets, so each resource says the
 // thing that is actually true of it rather than one sentence about "records".
 const deny=(message='That record is outside what your roles let you see.')=>{
  throw new ApiError({status:403,code:'FORBIDDEN',message});};
 async function employee(id:string){if(scopes.global)return;const values:unknown[]=[id,u!.orgId],clause=await employeeScopeClause(pool,u!.orgId,scopes,values);if(!(await pool.query(`SELECT 1 FROM employees WHERE id=$1 AND org_id=$2 AND ${clause}`,values)).rowCount)deny(
  'That employee record is outside the part of the directory your roles cover.');}
 async function task(id:string){
  if(!scopes.global){const values:unknown[]=[id,u!.orgId],clause=await taskScopeClause(pool,u!.orgId,scopes,values);/*
   * Their own task, or one they were put on to help (§note 13).
   *
   * The scope check runs before the handler does, so a collaborator was
   * refused here and never reached the rule that was meant to admit them —
   * which made being added to a task mean nothing at all.
   */
  const self=values.push(u!.id);
  if(!(await pool.query(`SELECT 1 FROM tasks WHERE id=$1 AND org_id=$2 AND (${clause} OR assignee_id=$${self}::uuid OR EXISTS(SELECT 1 FROM task_collaborators c WHERE c.task_id=tasks.id AND c.user_id=$${self}::uuid))`,values)).rowCount)deny(
   'That task belongs to somebody else. You can work a task assigned to you or one you have '
   +'been added to; anything else needs the "task.assign" permission.');}
  if(['task.update','task.transition','task.reorder'].includes(permission)){
   const r=await pool.query('SELECT assignee_id FROM tasks WHERE id=$1 AND org_id=$2',[id,u!.orgId]);
   /*
    * Somebody put on the task to help counts as being on it (§note 13).
    *
    * This check runs before the handler, so without it a collaborator was
    * refused here and never reached the rule meant to admit them — which
    * made being added to a task mean nothing at all.
    */
   const helping=r.rowCount?Boolean((await pool.query(
    'SELECT 1 FROM task_collaborators WHERE task_id=$1 AND user_id=$2',[id,u!.id])).rowCount):false;
   if(r.rowCount&&r.rows[0].assignee_id!==u!.id&&!helping){
    // Said in the words the module uses, because this is the message people
    // actually see: the handler's own check never runs once this denies.
    if(!u!.permissions.includes('task.assign'))throw new ApiError({status:403,code:'FORBIDDEN',
     message:'That task belongs to somebody else. You can update a task assigned to you or one '
      +'you have been added to; anything else needs the "task.assign" permission.'});
    const assignmentScope=resolveScopes(await scopesForPermission(req,'task.assign'));
    if(!assignmentScope.global){const values:unknown[]=[id,u!.orgId],clause=await taskScopeClause(pool,u!.orgId,assignmentScope,values);if(!(await pool.query(`SELECT 1 FROM tasks WHERE id=$1 AND org_id=$2 AND ${clause}`,values)).rowCount)deny();}
   }
  }
 }
 /**
  * Quick capture (`task.create`) is deliberately wider than task visibility:
  * a self/geo/team-scoped user can file work into any project in their org,
  * but still only sees tasks their task scope matches. Requiring an already
  * visible task made the FIRST task in a new project uncreatable. Users who
  * hold explicit `project` grants stay restricted to those projects.
  */
 async function project(id:string){if(scopes.global||scopes.projects.includes(id))return;if(['project.update','project.close','board.manage','cycle.manage','custom_field.manage'].includes(permission))deny();if(permission==='task.create'){if(scopes.projects.length)deny();if(!(await pool.query('SELECT 1 FROM projects WHERE id=$1 AND org_id=$2',[id,u!.orgId])).rowCount)deny();return;}const values:unknown[]=[id,u!.orgId],clause=await taskScopeClause(pool,u!.orgId,scopes,values);if(!(await pool.query(`SELECT 1 FROM tasks WHERE project_id=$1 AND org_id=$2 AND ${clause} LIMIT 1`,values)).rowCount)deny();}
 if(permission==='task.create'&&typeof body.assignee_id==='string'&&body.assignee_id!==u.id&&!u.permissions.includes('task.assign'))deny();
 if(params.id&&path.startsWith('/api/v1/tasks/:id'))await task(params.id);
 if(params.id&&path.startsWith('/api/v1/employees/:id'))await employee(params.id);
 if(params.id&&path.startsWith('/api/v1/projects/:id'))await project(params.id);
 /*
  * Putting somebody on a survey programme or a village's crew is decided by
  * the survey module's own authority rule (SV-018: the survey project's PM,
  * a team leader on it, an admin), which the route applies. The directory
  * scope refused a project's own PM one person at a time while start-gt let
  * them put the same people on in bulk.
  */
 const surveyAssignment=path==='/api/v1/survey/projects/:id/employees'||path==='/api/v1/survey/villages/:id/crew';
 if(!scopes.global){
  if(typeof body.employee_id==='string'&&!surveyAssignment)await employee(body.employee_id);
  if(typeof body.project_id==='string')await project(body.project_id);
  for(const key of ['predecessor_id','successor_id','task_id'])if(typeof body[key]==='string')await task(body[key] as string);
  const linked=path.startsWith('/api/v1/attendance/records/:id')?'attendance_records':path.startsWith('/api/v1/attendance/exceptions/:id')?'attendance_exceptions':path.startsWith('/api/v1/leave/requests/:id')?'leave_requests':null;
  if(linked&&params.id){const r=await pool.query(`SELECT x.employee_id FROM ${linked} x JOIN employees e ON e.id=x.employee_id WHERE x.id=$1 AND e.org_id=$2`,[params.id,u.orgId]);if(r.rowCount)await employee(r.rows[0].employee_id);}
  if(path.startsWith('/api/v1/boards/:id')&&params.id){const r=await pool.query('SELECT project_id FROM boards WHERE id=$1 AND org_id=$2',[params.id,u.orgId]);if(r.rowCount)await project(r.rows[0].project_id);}
 }
}
