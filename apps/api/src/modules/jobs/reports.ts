import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import jwt from 'jsonwebtoken';

/** The worker advisory lock serializes attempts. Generation uses the requester's current permissions. */
export async function runReportJobs(app:FastifyInstance,pool:Pool,secret:string){
 const jobs=(await pool.query("SELECT * FROM report_registry WHERE entry->>'status'='PENDING' AND COALESCE((entry->>'attempts')::int,0)<8 AND (entry->>'nextAttemptAt' IS NULL OR (entry->>'nextAttemptAt')::timestamptz<=now()) ORDER BY created_at LIMIT 2")).rows;
 for(const job of jobs){
  const token=jwt.sign({sub:job.created_by,org_id:job.org_id,type:'access',worker:true},secret,{expiresIn:60});
  const response=await app.inject({method:'POST',url:'/api/v1/reports',headers:{authorization:`Bearer ${token}`,'x-report-job-id':job.id,'idempotency-key':`report-job:${job.id}`},payload:job.entry.request});
  if(response.statusCode<300){
   await pool.query("INSERT INTO notifications(org_id,recipient_id,type,title,body,entity_type,entity_id,event_key) VALUES($1,$2,'REPORT_READY','Your report is ready','Open Reports to download it','report',$3,$4) ON CONFLICT DO NOTHING",[job.org_id,job.created_by,job.id,`report:${job.id}`]);
  }else{
   const attempts=Number(job.entry.attempts??0)+1,failed=response.statusCode<500||attempts>=8;
   await pool.query('UPDATE report_registry SET entry=entry||$2::jsonb WHERE id=$1',[job.id,JSON.stringify({status:failed?'FAILED':'PENDING',attempts,error:response.json().code??'GENERATION_FAILED',nextAttemptAt:new Date(Date.now()+Math.min(3600,2**attempts)*1000).toISOString()})]);
   if(failed)await pool.query("INSERT INTO notifications(org_id,recipient_id,type,title,body,entity_type,entity_id,event_key) VALUES($1,$2,'REPORT_FAILED','Report could not be generated','Open Reports to review the failure and try again','report',$3,$4) ON CONFLICT DO NOTHING",[job.org_id,job.created_by,job.id,`report-failed:${job.id}`]);
  }
 }
}
