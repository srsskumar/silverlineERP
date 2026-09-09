import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import jwt from 'jsonwebtoken';
/** Called under the worker's advisory lock; keys survive restarts and duplicate ticks. */
export async function runScheduledJobs(app:FastifyInstance,pool:Pool,secret:string):Promise<void>{
 const tasks=await pool.query(`SELECT t.id,t.org_id,t.project_id,t.assignee_id,p.project_manager_id,ev.type AS event,
   (SELECT lead.id FROM users assignee JOIN employees employee ON employee.id=assignee.employee_id JOIN users lead ON lead.employee_id=employee.reports_to WHERE assignee.id=t.assignee_id AND lead.auth_status='ACTIVE' LIMIT 1) AS team_lead_id,
   ev.type||':'||t.id||':'||t.planned_end_date AS event_key
  FROM tasks t JOIN projects p ON p.id=t.project_id JOIN organizations o ON o.id=t.org_id LEFT JOIN project_types pt ON pt.id=p.project_type_id
  CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE COALESCE(o.settings->>'timezone','Asia/Kolkata'))::date AS today) clock
  CROSS JOIN LATERAL (VALUES('sla.breached',t.planned_end_date<clock.today),('sla.at_risk',task_sla(t.status,t.planned_end_date,t.project_id)='AT_RISK'),('task.due',t.planned_end_date=clock.today),('sla.escalation.team_lead',clock.today>t.planned_end_date AND clock.today-t.planned_end_date>=COALESCE((COALESCE(p.sla_policy,pt.sla_policy)->>'team_lead_after_days')::int,0)),('sla.escalation.project_manager',clock.today>t.planned_end_date AND clock.today-t.planned_end_date>=COALESCE((COALESCE(p.sla_policy,pt.sla_policy)->>'project_manager_after_days')::int,1)),('sla.escalation.super_admin',clock.today>t.planned_end_date AND clock.today-t.planned_end_date>=COALESCE((COALESCE(p.sla_policy,pt.sla_policy)->>'super_admin_after_days')::int,3))) ev(type,eligible)
  WHERE t.status NOT IN('DONE','CANCELLED') AND p.status NOT IN('CLOSED','CANCELLED') AND ev.eligible
  AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.org_id=t.org_id AND e.event_key=ev.type||':'||t.id||':'||t.planned_end_date)
  ORDER BY t.planned_end_date,t.id LIMIT 100`);
 for(const t of tasks.rows){
  const db=await pool.connect();try{
   await db.query('BEGIN');
   await db.query("INSERT INTO domain_events(org_id,type,entity_type,entity_id,payload,event_key) VALUES($1,$2,'task',$3,$4,$5) ON CONFLICT DO NOTHING",[t.org_id,t.event,t.id,JSON.stringify({project_id:t.project_id}),t.event_key]);
   const recipients=t.event==='sla.escalation.team_lead'?[t.team_lead_id]:t.event==='sla.escalation.project_manager'?[t.project_manager_id]:t.event==='sla.escalation.super_admin'?(await db.query("SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.org_id=$1 AND u.auth_status='ACTIVE' AND r.code='SUPER_ADMIN' AND ur.scope_type IS NULL AND ur.scope_id IS NULL",[t.org_id])).rows.map(r=>r.id):[t.assignee_id];
   for(const recipient of new Set(recipients.filter(Boolean)))await db.query("INSERT INTO notifications(org_id,recipient_id,type,title,body,entity_type,entity_id,event_key) SELECT $1,id,'SLA_ALERT','Task deadline needs attention','Open Silverline to review the task','task',$3,$4 FROM users WHERE id=$2 AND org_id=$1 AND auth_status='ACTIVE' ON CONFLICT DO NOTHING",[t.org_id,recipient,t.id,t.event_key]);
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 const schedules=await pool.query('SELECT s.* FROM report_schedules s JOIN users u ON u.id=s.created_by WHERE s.active AND s.next_run_at<=now() AND u.auth_status=\'ACTIVE\' ORDER BY s.next_run_at LIMIT 5');
 for(const s of schedules.rows){
  const token=jwt.sign({sub:s.created_by,org_id:s.org_id,type:'access',worker:true},secret,{expiresIn:60});
  const response=await app.inject({method:'POST',url:'/api/v1/reports',headers:{authorization:`Bearer ${token}`,'x-request-id':`schedule:${s.id}`,'idempotency-key':`schedule:${s.id}:${new Date(s.next_run_at).toISOString()}`},payload:{type:s.report_type,format:s.format,filters:s.filters}});
  if(response.statusCode<300){const report=response.json();if(report.status==='READY')await pool.query("INSERT INTO notifications(org_id,recipient_id,type,title,body,entity_type,entity_id,event_key) VALUES($1,$2,'REPORT_READY','Scheduled report ready','Open Reports to download your report','report',$3,$4) ON CONFLICT DO NOTHING",[s.org_id,s.created_by,report.id,`report:${report.id}`]);await pool.query("UPDATE report_schedules SET last_run_at=now(),next_run_at=now()+CASE frequency WHEN 'DAILY' THEN interval '1 day' WHEN 'WEEKLY' THEN interval '7 days' ELSE interval '1 month' END,error=NULL,failures=0 WHERE id=$1",[s.id]);}
  else await pool.query("UPDATE report_schedules SET failures=failures+1,active=failures<7,error=$2,next_run_at=now()+interval '15 minutes' WHERE id=$1",[s.id,response.json().code??'GENERATION_FAILED']);
 }
}
