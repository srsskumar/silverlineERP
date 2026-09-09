import {scopesForPermission} from './auth.js';
import type {FastifyRequest} from 'fastify';
import {ApiError} from '@silverline/shared';
import {resolveScopes,employeeScopeClause,taskScopeClause} from './scopes.js';

/** Check record access after the endpoint permission, including child routes. */
export async function enforceRecordScope(req:FastifyRequest,permission:string):Promise<void>{
 const u=req.authUser;if(!u)return;const pool=req.server.db,scopes=resolveScopes(u.scopes),path=req.routeOptions.url??req.url,params=req.params as {id?:string;taskId?:string},body=(req.body??{}) as Record<string,unknown>;
 const deny=()=>{throw new ApiError({status:403,code:'FORBIDDEN',message:'Record is outside your permitted scope'});};
 async function employee(id:string){if(scopes.global)return;const values:unknown[]=[id,u!.orgId],clause=await employeeScopeClause(pool,u!.orgId,scopes,values);if(!(await pool.query(`SELECT 1 FROM employees WHERE id=$1 AND org_id=$2 AND ${clause}`,values)).rowCount)deny();}
 async function task(id:string){
  if(!scopes.global){const values:unknown[]=[id,u!.orgId],clause=await taskScopeClause(pool,u!.orgId,scopes,values);if(!(await pool.query(`SELECT 1 FROM tasks WHERE id=$1 AND org_id=$2 AND (${clause} OR assignee_id=$${values.push(u!.id)}::uuid)`,values)).rowCount)deny();}
  if(['task.update','task.transition','task.reorder'].includes(permission)){
   const r=await pool.query('SELECT assignee_id FROM tasks WHERE id=$1 AND org_id=$2',[id,u!.orgId]);
   if(r.rowCount&&r.rows[0].assignee_id!==u!.id){
    if(!u!.permissions.includes('task.assign'))deny();
    const assignmentScope=resolveScopes(await scopesForPermission(req,'task.assign'));
    if(!assignmentScope.global){const values:unknown[]=[id,u!.orgId],clause=await taskScopeClause(pool,u!.orgId,assignmentScope,values);if(!(await pool.query(`SELECT 1 FROM tasks WHERE id=$1 AND org_id=$2 AND ${clause}`,values)).rowCount)deny();}
   }
  }
 }
 async function project(id:string){if(scopes.global||scopes.projects.includes(id))return;if(['project.update','project.close','board.manage','cycle.manage','custom_field.manage'].includes(permission))deny();const values:unknown[]=[id,u!.orgId],clause=await taskScopeClause(pool,u!.orgId,scopes,values);if(!(await pool.query(`SELECT 1 FROM tasks WHERE project_id=$1 AND org_id=$2 AND ${clause} LIMIT 1`,values)).rowCount)deny();}
 if(permission==='task.create'&&typeof body.assignee_id==='string'&&body.assignee_id!==u.id&&!u.permissions.includes('task.assign'))deny();
 if(params.id&&path.startsWith('/api/v1/tasks/:id'))await task(params.id);
 if(params.id&&path.startsWith('/api/v1/employees/:id'))await employee(params.id);
 if(params.id&&path.startsWith('/api/v1/projects/:id'))await project(params.id);
 if(!scopes.global){
  if(typeof body.employee_id==='string')await employee(body.employee_id);
  if(typeof body.project_id==='string')await project(body.project_id);
  for(const key of ['predecessor_id','successor_id','task_id'])if(typeof body[key]==='string')await task(body[key] as string);
  const linked=path.startsWith('/api/v1/attendance/records/:id')?'attendance_records':path.startsWith('/api/v1/attendance/exceptions/:id')?'attendance_exceptions':path.startsWith('/api/v1/leave/requests/:id')?'leave_requests':null;
  if(linked&&params.id){const r=await pool.query(`SELECT x.employee_id FROM ${linked} x JOIN employees e ON e.id=x.employee_id WHERE x.id=$1 AND e.org_id=$2`,[params.id,u.orgId]);if(r.rowCount)await employee(r.rows[0].employee_id);}
  if(path.startsWith('/api/v1/boards/:id')&&params.id){const r=await pool.query('SELECT project_id FROM boards WHERE id=$1 AND org_id=$2',[params.id,u.orgId]);if(r.rowCount)await project(r.rows[0].project_id);}
 }
}
