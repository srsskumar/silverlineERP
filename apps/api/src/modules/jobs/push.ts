import type {Pool} from 'pg';
/** Fixed provider endpoint; payloads expose only entity references and generic copy. */
export async function runPushDelivery(pool:Pool,fetcher:typeof fetch=fetch):Promise<void>{
 if(process.env.PUSH_ENABLED!=='true')return;
 await pool.query(`INSERT INTO notification_deliveries(notification_id,device_id)
  SELECT n.id,d.id FROM notifications n JOIN device_registrations d ON d.user_id=n.recipient_id JOIN users u ON u.id=d.user_id
  WHERE n.created_at>now()-interval '1 day' AND n.created_at>=d.created_at AND d.push_token IS NOT NULL AND d.revoked_at IS NULL AND u.auth_status='ACTIVE' AND u.notification_preferences->>'push'='true' ON CONFLICT DO NOTHING`);
 const rows=(await pool.query(`SELECT nd.*,d.push_token,n.entity_type,n.entity_id FROM notification_deliveries nd JOIN device_registrations d ON d.id=nd.device_id JOIN notifications n ON n.id=nd.notification_id JOIN users u ON u.id=d.user_id WHERE nd.status IN('PENDING','ACCEPTED') AND nd.next_attempt_at<=now() AND d.revoked_at IS NULL AND u.auth_status='ACTIVE' AND u.notification_preferences->>'push'='true' ORDER BY nd.created_at LIMIT 20`)).rows;
 for(const d of rows){
  let status='PENDING',error:string|null=null,ticket:string|null=d.provider_id,delay=2**Math.min(d.attempts+1,12);
  try{
   if(!/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(d.push_token??'')){status='FAILED';error='INVALID_TOKEN';}
   else {
    const receipt=d.status==='ACCEPTED';
    const response=await fetcher(`https://exp.host/--/api/v2/push/${receipt?'getReceipts':'send'}`,{method:'POST',headers:{'content-type':'application/json',...(process.env.EXPO_ACCESS_TOKEN?{authorization:`Bearer ${process.env.EXPO_ACCESS_TOKEN}`}:{})},signal:AbortSignal.timeout(10000),body:JSON.stringify(receipt?{ids:[ticket]}:{to:d.push_token,title:'Silverline update',body:'Open the app to review your latest update.',data:{notificationId:d.notification_id,entityType:d.entity_type,entityId:d.entity_id}})});
    if(!response.ok){error=`HTTP_${response.status}`;if(response.status<500&&response.status!==429)status='FAILED';}
    else {
     const body=await response.json() as {data?:any},result=receipt?body.data?.[ticket!]:body.data;
     if(result?.status==='ok'){status=receipt?'DELIVERED':'ACCEPTED';ticket=result.id??ticket;delay=900;}
     else if(result?.status==='error'){
      error=result.details?.error??'PROVIDER_ERROR';status=['DeviceNotRegistered','MessageTooBig','InvalidCredentials'].includes(error!)?'FAILED':'PENDING';
      if(error==='DeviceNotRegistered')await pool.query('UPDATE device_registrations SET push_token=NULL WHERE id=$1',[d.device_id]);
     }else {status=receipt?'ACCEPTED':'PENDING';error='RECEIPT_UNAVAILABLE';delay=900;}
    }
   }
  }catch{error='PROVIDER_UNAVAILABLE';status=d.status;}
  if(d.attempts>=7&&!['DELIVERED','FAILED'].includes(status)){status='FAILED';error??='RETRIES_EXHAUSTED';}
  await pool.query("UPDATE notification_deliveries SET status=$2,error=$3,provider_id=$4,attempts=attempts+1,next_attempt_at=now()+$5*interval '1 second' WHERE id=$1",[d.id,status,error,ticket,delay]);
 }
}
