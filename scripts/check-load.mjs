import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {Pool} from 'pg';
process.env.NODE_ENV='test';
const {migrate}=await import('../apps/api/dist/database/migrate.js');
const {seedDatabase}=await import('../apps/api/dist/database/seed.js');
const {buildApp}=await import('../apps/api/dist/app.js');
const bcrypt=(await import('bcryptjs')).default;
const base=new URL(process.env.TEST_DATABASE_URL??'postgresql://localhost:5432/silverline_test');
if(!/(^test_|_test$)/.test(base.pathname.slice(1)))throw new Error('Use a dedicated TEST_DATABASE_URL');
const database=`sl_load_${Date.now()}_test`,adminUrl=new URL(base);adminUrl.pathname='/postgres';
const admin=new Pool({connectionString:adminUrl.toString()}),url=new URL(base);url.pathname='/'+database;
let created=false,pool,app;
try{
 await admin.query(`CREATE DATABASE "${database}"`);created=true;await migrate(url.toString());
 pool=new Pool({connectionString:url.toString(),max:10});const seed=await seedDatabase(pool,{bcryptRounds:4});
 const workspace=(await pool.query("INSERT INTO workspaces(org_id,name) VALUES($1,'Load fixture') RETURNING id",[seed.orgId])).rows[0].id;
 const project=(await pool.query("INSERT INTO projects(org_id,workspace_id,code,name,status) VALUES($1,$2,'LOAD','Load fixture','ACTIVE') RETURNING id",[seed.orgId,workspace])).rows[0].id;
 const password=randomBytes(24).toString('hex'),hash=await bcrypt.hash(password,4),users=[];
 for(let n=0;n<200;n++){
  const employee=(await pool.query("INSERT INTO employees(org_id,emp_no,first_name,phone,date_of_joining,status) VALUES($1,$2,'Load user',$3,'2026-01-01','ACTIVE') RETURNING id",[seed.orgId,`LOAD${n}`,`+91999${String(n).padStart(7,'0')}`])).rows[0].id;
  const user=(await pool.query('INSERT INTO users(org_id,username,password_hash,employee_id) VALUES($1,$2,$3,$4) RETURNING id,username',[seed.orgId,`load${n}`,hash,employee])).rows[0];
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='EMPLOYEE' AND org_id IS NULL",[user.id]);
  const tasks=(await pool.query("INSERT INTO tasks(org_id,project_id,title,assignee_id) SELECT $1,$2,'Fixture '||g,$3 FROM generate_series(1,20) g RETURNING id",[seed.orgId,project,user.id])).rows;
  users.push({...user,task:tasks[0].id});
 }
 app=await buildApp({pool,jwtSecret:randomBytes(32).toString('hex'),loginRateLimitMax:1000});await app.listen({host:'127.0.0.1',port:0});
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 for(const u of users){const response=await fetch(origin+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.username,password})});if(!response.ok)throw new Error('Load fixture login failed');u.token=(await response.json()).access_token;}
 const samples=[],errors=[],started=performance.now();
 await Promise.all(users.map(async(u)=>{
  for(let round=0;round<8;round++){
   const write=round===3||round===7,path=write?`tasks/${u.task}/comments`:round%3===0?'attendance/me?limit=10':round%3===1?'tasks?assignee_me=true&limit=20':'notifications?limit=20';
   const before=performance.now();
   try{const response=await fetch(`${origin}/api/v1/${path}`,{method:write?'POST':'GET',headers:{authorization:`Bearer ${u.token}`,'content-type':'application/json',...(write?{'idempotency-key':randomUUID()}:{})},...(write?{body:JSON.stringify({body:'Load verification'})}:{}),signal:AbortSignal.timeout(30000)});await response.arrayBuffer();samples.push(performance.now()-before);if(!response.ok)errors.push(response.status);}catch{errors.push('transport');samples.push(performance.now()-before);}
  }
 }));
 const duration=performance.now()-started; samples.sort((a,b)=>a-b);
 const result={generated_at:new Date().toISOString(),environment:'Local loopback HTTP, PostgreSQL, one API process; excludes UI rendering and native startup',concurrent_users:200,requests:samples.length,read_write_mix:'75% reads / 25% comment writes',fixture_tasks:4000,errors:errors.length,statuses:[...new Set(errors)],duration_ms:Math.round(duration),requests_per_second:Number((samples.length/(duration/1000)).toFixed(1)),p50_ms:Math.round(samples[Math.floor(samples.length*.5)]),p95_ms:Math.round(samples[Math.floor(samples.length*.95)]),p99_ms:Math.round(samples[Math.floor(samples.length*.99)]),node:process.version};
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/load-local.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 if(errors.length||result.p95_ms>=3000)process.exitCode=1;
}finally{if(app)await app.close();if(pool)await pool.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();}
