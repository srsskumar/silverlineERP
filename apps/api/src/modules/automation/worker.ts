import {runProviderJobs} from "../integrations/worker.js";
import {runPushDelivery} from "../jobs/push.js";
import {runReportJobs} from "../jobs/reports.js";
import {runScheduledJobs} from "../jobs/scheduled.js";
import {runSurveyAlerts} from "../jobs/surveyAlerts.js";
import {drainSurveyAlertMail} from "../jobs/surveyMail.js";
import {reverseGeocodingEnabled,runPlaceNames} from "../jobs/placeNames.js";
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { decryptPii } from '../../common/crypto.js';

export function publicAddress(ip:string):boolean {
 if(ip.includes(':'))return false; // IPv4-only delivery with an explicitly pinned public address.
 const p=ip.split('.').map(Number);if(p.length!==4||p.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
 return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&[0,168].includes(p[1]))||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===198&&[18,19,51].includes(p[1]))||(p[0]===203&&p[1]===0));
}
async function deliver(url:string,secret:string,body:string,id:string):Promise<number>{
 const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password||target.port&&target.port!=='443')throw new Error('Unsupported webhook destination');
 const resolved=await lookup(target.hostname,{all:true,family:4});if(!resolved.length||resolved.some(r=>!publicAddress(r.address)))throw new Error('Webhook destination is not a public address');
 const timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
 return new Promise((resolve,reject)=>{const req=request(target,{method:'POST',lookup:(_host,_options,cb)=>cb(null,resolved[0].address,4),headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-silverline-event':id,'x-silverline-timestamp':timestamp,'x-silverline-signature':`sha256=${signature}`}},res=>{res.resume();resolve(res.statusCode??500);});req.setTimeout(10000,()=>req.destroy(new Error('Webhook timeout')));req.on('error',reject);req.end(body);});
}
/**
 * The text recorded when something fails, short enough for a column and a
 * log line. "Processing failed" told whoever opened the row that it had
 * failed, which they knew, and not why, which they needed.
 */
export function failureText(e:unknown):string{
 const text=e instanceof Error?e.message:String(e);
 return (text||'Unknown error').slice(0,500);
}

/**
 * Run one part of the worker pass, and log rather than rethrow if it fails.
 *
 * The parts are independent: SLA alerts, scheduled reports, automation,
 * webhooks, push, provider jobs. One throwing used to end the whole pass,
 * so a single bad report schedule stopped every webhook, push and
 * automation until somebody noticed -- and nothing said why they had.
 */
export async function isolated(name:string,job:()=>Promise<unknown>):Promise<void>{
 try{await job();}
 catch(e){console.error(`Background job "${name}" failed: ${failureText(e)}`);}
}

export async function runJobs(app:FastifyInstance,pool:Pool,jwtSecret:string):Promise<{events:number;deliveries:number}> {
 // The run holds one connection for its exclusivity lock and issues every
 // other query alongside it, so a pool of one deadlocks against itself and
 // surfaces ten seconds later as an opaque 500. Say so instead.
 if(pool.options?.max!==undefined&&pool.options.max<2)throw new Error('Background processing needs PGPOOL_MAX>=2 (it holds one connection for its lock while working); got '+pool.options.max);
 const lock=await pool.connect(),count={events:0,deliveries:0};
 try {
  // A session-level lock is not usable through a transaction-mode connection
  // pooler, which hands the same backend to a different client between
  // statements. Holding it inside an explicit transaction keeps the mutual
  // exclusion (one worker at a time) and releases it on COMMIT no matter how
  // the run ends — including a serverless invocation that is simply frozen.
  await lock.query('BEGIN');
  const acquired=await lock.query('SELECT pg_try_advisory_xact_lock(7814239) AS ok');if(!acquired.rows[0].ok){await lock.query('COMMIT');return count;}
  await isolated('scheduled jobs',()=>runScheduledJobs(app,pool,jwtSecret));
  // Survey alerts (§27). Failing here must not stop the rest of the pass:
  // the bottleneck report still shows everything these would have said.
  await isolated('survey alerts',()=>runSurveyAlerts(pool));
  // Finding what is wrong and telling somebody about it are separate passes:
  // a mail relay having a bad afternoon must not stop the finding.
  await isolated('survey alert mail',()=>drainSurveyAlertMail(pool));
  await isolated('report jobs',()=>runReportJobs(app,pool,jwtSecret));
  await isolated('automation events',async()=>{
  const events=await pool.query('SELECT * FROM domain_events WHERE processed_at IS NULL AND attempts<8 AND next_attempt_at<=now() ORDER BY created_at LIMIT 25');
  for(const event of events.rows){
   try{
    const task=event.entity_type==='task'?(await pool.query('SELECT * FROM tasks WHERE id=$1 AND org_id=$2',[event.entity_id,event.org_id])).rows[0]:null;
    if(event.depth===0){
     const rules=await pool.query('SELECT r.* FROM automation_rules r JOIN users u ON u.id=r.acting_user_id WHERE r.org_id=$1 AND r.trigger=$2 AND r.active AND u.auth_status=\'ACTIVE\' AND (r.project_id IS NULL OR r.project_id=$3)',[event.org_id,event.type,task?.project_id??event.payload.project_id??null]);
     for(const rule of rules.rows){
      let matches=true;
      for(const c of rule.conditions){
       if(c.field==='label_id'){if(!task||!(await pool.query('SELECT 1 FROM task_labels WHERE task_id=$1 AND label_id=$2',[task.id,c.value])).rowCount)matches=false;}
       else if(c.field==='assignee_role'){if(!task?.assignee_id||!(await pool.query('SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.code=$2',[task.assignee_id,c.value])).rowCount)matches=false;}
       else if(String((task??event.payload)[c.field])!==c.value)matches=false;
      }
      if(!matches)continue;
      if((await pool.query('SELECT 1 FROM automation_executions WHERE rule_id=$1 AND event_id=$2',[rule.id,event.id])).rowCount)continue;
      const held=(await pool.query('SELECT DISTINCT rp.permission_code FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=$1',[rule.acting_user_id])).rows.map(r=>r.permission_code);
      if(!held.includes('automation.manage'))continue;
      const access=jwt.sign({sub:rule.acting_user_id,org_id:event.org_id,type:'access',worker:true},jwtSecret,{expiresIn:60});
      const ruleAccess=await app.inject({method:'GET',url:`/api/v1/automation-rules/${rule.id}`,headers:{authorization:`Bearer ${access}`}});
      if(ruleAccess.statusCode!==200){await pool.query('INSERT INTO automation_executions(org_id,rule_id,event_id,status,results) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[event.org_id,rule.id,event.id,'FAILED',JSON.stringify([{status:ruleAccess.statusCode,code:'RULE_AUTHORITY_CHANGED'}])]);continue;}
      const results=[];let failed=false;
      for(let index=0;index<rule.actions.length;index++){
       const a=rule.actions[index],key=`automation:${event.id}:${rule.id}:${index}`;
       if(a.type==='notify'||a.type==='webhook'){
        const response=await app.inject({method:'POST',url:`/api/v1/automation-rules/${rule.id}/dispatch`,headers:{authorization:`Bearer ${access}`,'idempotency-key':key},payload:{event_id:event.id,action_index:index}});
        results.push({action:a.type,status:response.statusCode,code:response.statusCode>=400?response.json().code:undefined});
        if(response.statusCode>=500)throw new Error('Action temporarily unavailable');
        if(response.statusCode>=400){failed=true;break;}continue;
       }
       if(!task){results.push({action:a.type,status:422});failed=true;break;}
       const current=(await pool.query('SELECT version FROM tasks WHERE id=$1',[task.id])).rows[0];
       const suffix=a.type==='status'?'status':a.type==='assign'?'assign':a.type==='label'?'labels':'comments';
       const payload=a.type==='status'?{status:a.value}:a.type==='assign'?{assignee_id:a.value,reason:`Automation: ${rule.name}`} :a.type==='label'?{label_id:a.value}:{body:a.value};
       const response=await app.inject({method:a.type==='status'?'PATCH':'POST',url:`/api/v1/tasks/${task.id}/${suffix}`,headers:{authorization:`Bearer ${access}`,'if-match':String(current.version),'idempotency-key':key,'x-request-id':key},payload});
       results.push({action:a.type,status:response.statusCode,code:response.statusCode>=400?response.json().code:undefined});
       if(response.statusCode>=500)throw new Error('Action temporarily unavailable');
       if(response.statusCode>=400){failed=true;break;}
      }
      await pool.query('INSERT INTO automation_executions(org_id,rule_id,event_id,status,results) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[event.org_id,rule.id,event.id,failed?'FAILED':'SUCCEEDED',JSON.stringify(results)]);
      await pool.query('UPDATE automation_rules SET last_run_at=now() WHERE id=$1',[rule.id]);
     }
    }
    await pool.query('INSERT INTO webhook_deliveries(org_id,subscription_id,event_id) SELECT $1,id,$2 FROM webhook_subscriptions WHERE org_id=$1 AND active AND events ? $3 ON CONFLICT DO NOTHING',[event.org_id,event.id,event.type]);
    await pool.query('UPDATE domain_events SET processed_at=now(),error=NULL WHERE id=$1',[event.id]);count.events++;
   }catch(e){
    // The real reason, so the row says what to fix. Error text from our own
    // routes and queries -- webhook destinations and responses are never
    // part of it, since deliveries are recorded separately below.
    await pool.query("UPDATE domain_events SET attempts=attempts+1,error=$2,next_attempt_at=now()+least(3600,power(2,attempts+1)) * interval '1 second' WHERE id=$1",[event.id,failureText(e)]);
   }
  }
  });
  /*
   * Deliveries go out only while whoever created the subscription still
   * holds webhook.manage across the whole organisation: a role row with no
   * scope at all. It read `scope_type IS NULL OR scope_id IS NULL`, which
   * also took a half-set row -- a district chosen with no district, say --
   * as organisation-wide, and kept a narrowed creator's webhooks firing.
   * Both columns empty, as every other authority check in the background
   * workers already requires.
   */
  await isolated('webhook deliveries',async()=>{
  const deliveries=await pool.query("SELECT d.*,s.url,s.secret_encrypted,e.type,e.entity_type,e.entity_id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id JOIN domain_events e ON e.id=d.event_id WHERE d.status='PENDING' AND d.next_attempt_at<=now() AND s.active AND EXISTS(SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE u.id=s.created_by AND u.auth_status='ACTIVE' AND rp.permission_code='webhook.manage' AND ur.scope_type IS NULL AND ur.scope_id IS NULL) ORDER BY d.created_at LIMIT 20");
  for(const d of deliveries.rows){let status=0;try{status=await deliver(d.url,decryptPii(d.secret_encrypted),JSON.stringify({id:d.event_id,type:d.type,entity_type:d.entity_type,entity_id:d.entity_id}),d.event_id);}catch{/* bounded retry, no private destination or response content logged */}
   const ok=status>=200&&status<300;await pool.query("UPDATE webhook_deliveries SET status=$2,attempts=attempts+1,response_status=$3,error=$4,next_attempt_at=now()+least(3600,power(2,attempts+1))*interval '1 second' WHERE id=$1",[d.id,ok?'DELIVERED':d.attempts>=7?'FAILED':'PENDING',status||null,ok?null:'Delivery unsuccessful']);count.deliveries++;
  }
  });
  await isolated('push delivery',()=>runPushDelivery(pool));
  await isolated('provider jobs',()=>runProviderJobs(pool));
  // Naming the place each positioned punch was made from, a bounded batch
  // per pass at the geocoder's one request a second. Off by GEOCODING_REVERSE=off.
  if(reverseGeocodingEnabled())await isolated('punch place names',()=>runPlaceNames(pool));
  return count;
 }finally{await lock.query('COMMIT').catch(()=>lock.query('ROLLBACK').catch(()=>{}));lock.release();}
}
