import type {Pool} from 'pg';
import {encryptPii,decryptPii} from '../../common/crypto.js';
import {callProvider,providerConfig,ProviderError,type Provider} from './gateway.js';
export async function runProviderJobs(pool:Pool,fetcher:typeof fetch=fetch){
 for(const provider of ['SMS','WHATSAPP'] as const){
  if(!providerConfig(provider).enabled)continue;
  const notices=(await pool.query(`SELECT n.id,n.org_id,n.recipient_id,e.phone FROM notifications n JOIN users u ON u.id=n.recipient_id JOIN employees e ON e.id=u.employee_id WHERE n.created_at>now()-interval '1 day' AND u.auth_status='ACTIVE' AND e.status='ACTIVE' AND u.notification_preferences->>$1='true' AND NOT EXISTS(SELECT 1 FROM provider_jobs j WHERE j.notification_id=n.id AND j.provider=$2) ORDER BY n.created_at LIMIT 100`,[provider.toLowerCase(),provider])).rows;
  for(const n of notices)await pool.query('INSERT INTO provider_jobs(org_id,provider,created_by,notification_id,payload_encrypted) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[n.org_id,provider,n.recipient_id,n.id,encryptPii(JSON.stringify({recipient:n.phone,template:'silverline_update',parameters:{message:'Open Silverline to review your latest update.'}}))]);
 }
 const jobs=(await pool.query("SELECT * FROM provider_jobs WHERE status IN('PENDING','ACCEPTED') AND next_attempt_at<=now() ORDER BY created_at LIMIT 20")).rows;
 for(const job of jobs){
  if(!providerConfig(job.provider as Provider).enabled)continue;
  const user=(await pool.query("SELECT u.auth_status,u.notification_preferences,EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=u.id AND rp.permission_code='inventory.manage' AND ur.scope_type IS NULL AND ur.scope_id IS NULL) AS accounting FROM users u WHERE u.id=$1 AND u.org_id=$2",[job.created_by,job.org_id])).rows[0];
  if(!user||user.auth_status!=='ACTIVE'||(job.provider==='ACCOUNTING'?!user.accounting:!user.notification_preferences[job.provider.toLowerCase()])){await pool.query("UPDATE provider_jobs SET status='CANCELLED',error='AUTHORITY_CHANGED',updated_at=now() WHERE id=$1",[job.id]);continue;}
  let status='DELIVERED',error:string|null=null,providerId:string|null=job.provider_id;
  try{const result=await callProvider(job.provider,job.status==='ACCEPTED'?{operation:'receipt',id:job.provider_id}:{operation:'send',...JSON.parse(decryptPii(job.payload_encrypted))},job.status==='ACCEPTED'?`${job.id}:receipt:${job.attempts}`:job.id,fetcher);if(result.accepted!==true)throw new ProviderError('PROVIDER_REJECTED',false);providerId=typeof result.id==='string'?result.id.slice(0,200):providerId;if(result.delivered!==true){if(!providerId)throw new ProviderError('INVALID_PROVIDER_RESPONSE',false);status=job.attempts<7?'ACCEPTED':'FAILED';if(status==='FAILED')error='RECEIPT_TIMEOUT';}}
  catch(e){error=e instanceof ProviderError?e.code:'PROCESSING_FAILED';status=e instanceof ProviderError&&e.retryable&&job.attempts<7?job.status:'FAILED';}
  await pool.query("UPDATE provider_jobs SET status=$2,error=$3,provider_id=$4,attempts=attempts+1,next_attempt_at=now()+greatest(60,least(3600,power(2,attempts+1)))*interval '1 second',updated_at=now() WHERE id=$1",[job.id,status,error,providerId]);
 }
}
