import type {Pool,PoolClient} from 'pg';
import {resolveScopes,employeeScopeClause,taskScopeClause,type ScopeAssignment} from './scopes.js';

type ScopedUser={id:string;orgId:string;scopes?:ScopeAssignment[]};
/** Read-only CTEs apply the same record scope to lists, joins, counts and exports. */
export function scopedReads(db:Pool|PoolClient,pool:Pool,user:ScopedUser):Pool|PoolClient {
 const scope=resolveScopes(user.scopes??[]);
 if(scope.global)return db;
 return {query:async(sql:string,params:unknown[]=[])=>{
  if(!/^\s*SELECT\b/i.test(sql))throw new Error('scopedReads accepts SELECT queries only');
  const values=[...params],employee=await employeeScopeClause(pool,user.orgId,scope,values),task=await taskScopeClause(pool,user.orgId,scope,values);
  const org=`$${values.push(user.orgId)}`,projects=`$${values.push(scope.projects)}`,own=`$${values.push(user.id)}`;
  const prefix=`WITH employees AS (SELECT * FROM public.employees WHERE org_id=${org} AND ${employee}),
   tasks AS (SELECT * FROM public.tasks WHERE org_id=${org} AND (${task} OR assignee_id=${own}::uuid)),
   projects AS (SELECT * FROM public.projects WHERE org_id=${org} AND (id=ANY(${projects}::uuid[]) OR id IN(SELECT project_id FROM tasks))),
   leave_requests AS (SELECT * FROM public.leave_requests WHERE org_id=${org} AND employee_id IN(SELECT id FROM employees)),
   attendance_records AS (SELECT * FROM public.attendance_records WHERE employee_id IN(SELECT id FROM employees)),
   attendance_exceptions AS (SELECT * FROM public.attendance_exceptions WHERE employee_id IN(SELECT id FROM employees)),
   audit_events AS (SELECT * FROM public.audit_events WHERE org_id=${org} AND (actor_id=${own}::uuid OR (entity_type='task' AND entity_id IN(SELECT id FROM tasks)) OR (entity_type='project' AND entity_id IN(SELECT id FROM projects)) OR (entity_type='employee' AND entity_id IN(SELECT id FROM employees)))) `;
  return db.query(prefix+sql,values);
 }} as PoolClient;
}
export async function employeeRestriction(pool:Pool,user:ScopedUser,values:unknown[],idColumn:string):Promise<string>{
 const scope=resolveScopes(user.scopes??[]);if(scope.global)return 'TRUE';
 const clause=await employeeScopeClause(pool,user.orgId,scope,values);return `${idColumn} IN(SELECT employees.id FROM employees WHERE ${clause})`;
}
export async function projectRestriction(pool:Pool,user:ScopedUser,values:unknown[]):Promise<string>{
 const scope=resolveScopes(user.scopes??[]);if(scope.global)return 'TRUE';
 const clause=await taskScopeClause(pool,user.orgId,scope,values),projects=`$${values.push(scope.projects)}`;
 // A project they manage is theirs even before anybody has put a task on it.
 const managed=scope.selfUsers?.length?` OR project_manager_id=ANY($${values.push(scope.selfUsers)}::uuid[])`:'';
 return `(id=ANY(${projects}::uuid[])${managed} OR id IN(SELECT project_id FROM tasks WHERE ${clause}))`;
}
