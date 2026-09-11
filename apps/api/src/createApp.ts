import {buildAuthenticate,requirePermission} from "./common/auth.js";
import {transactionPool} from './common/transactionContext.js';
import {registerOrgImport} from "./modules/org/import.js";
import {registerIntegrationRoutes} from "./modules/integrations/routes.js";
import {registerJobRoutes} from "./modules/jobs/routes.js";
import { registerAutomationRoutes } from "./modules/automation/routes.js";
import { registerInventoryRoutes } from "./modules/inventory/routes.js";
import { registerPlanningRoutes } from "./modules/planning/routes.js";
import { registerAnalyticsRoutes } from "./modules/analytics/routes.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerPayrollDocuments } from "./modules/payroll/documents.js";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { getConfig, type ApiConfigOverrides } from "./config.js";
import { registerRequestId } from "./common/requestId.js";
import { registerErrorHandler } from "./common/httpErrors.js";
import { createPool } from "./database/db.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerAuditRoutes } from "./modules/audit/routes.js";
import { registerOrgUnitRoutes } from "./modules/org/routes.js";
import { registerEmployeeRoutes } from "./modules/employees/routes.js";
import { registerHolidayRoutes } from "./modules/holidays/routes.js";
import { registerGeoFenceRoutes } from "./modules/geo/routes.js";
import { registerAttendanceRoutes } from "./modules/attendance/routes.js";
import { registerLeaveRoutes } from "./modules/leave/routes.js";
import { registerWorkRoutes } from "./modules/work/routes.js";
import { registerS5Routes } from "./modules/s5/routes.js";
import { registerS6Routes } from "./modules/s6/routes.js";
import { registerPayrollRoutes } from "./modules/payroll/routes.js";

export interface BuildAppOptions extends ApiConfigOverrides {
  pool?: Pool;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = getConfig(options);
  const pool = transactionPool(options.pool ?? createPool(config.databaseUrl));

  // 8 MiB: large enough for the S1 5 MiB document cap to be enforced by
  // the route (422) instead of the framework (413).
  const app = Fastify({ logger: config.nodeEnv==='production'?{level:'info',redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie']}:false,disableRequestLogging:true,bodyLimit:8*1024*1024 });
  const counters=new Map<string,{requests:number;errors:number;total_ms:number}>();
  app.addHook('onResponse',async(req,reply)=>{
    const route=req.routeOptions.url??'unmatched',key=req.method+' '+route,m=counters.get(key)??{requests:0,errors:0,total_ms:0};
    m.requests++;if(reply.statusCode>=500)m.errors++;m.total_ms+=reply.elapsedTime;counters.set(key,m);
    req.log.info({request_id:req.requestId,method:req.method,route,status:reply.statusCode,duration_ms:Math.round(reply.elapsedTime)},'request completed');
  });
  app.get('/api/v1/operations/metrics',{preHandler:async req=>{await requirePermission(buildAuthenticate({pool,jwtSecret:config.jwtSecret}),'admin.configure')(req);}},async()=>({uptime_seconds:Math.floor(process.uptime()),database:{total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount},routes:[...counters].map(([route,m])=>({route,...m,mean_ms:Number((m.total_ms/m.requests).toFixed(2))}))}));
  app.addHook('preSerialization',async(req,_reply,payload)=>{
    const user=req.authUser,path=req.routeOptions.url??'';
    if(!user?.roles.length||!user.roles.every(r=>r==='CLIENT_VIEWER')||!/^\/api\/v1\/(tasks|projects)(?:\/:id)?$/.test(path))return payload;
    const allowed=new Set(['id','code','name','title','project_id','workspace_id','status','priority','version','planned_start_date','planned_end_date','actual_start_at','actual_end_at','sla_status','progress','task_count','completed_task_count','allowed_next','created_at','updated_at']);
    const safe=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([key])=>allowed.has(key)));
    const body=payload as Record<string,any>;return Array.isArray(body?.data)?{...body,data:body.data.map(safe)}:body&&typeof body==='object'?safe(body):body;
  });
  app.decorate("db", pool);
  app.decorate("appConfig", config);

  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['x-request-id', 'content-disposition', 'retry-after'],
    credentials: true,
  });
  if (!options.pool) app.addHook('onClose', async () => { await pool.end(); });
  await registerRequestId(app);
  await registerErrorHandler(app);

  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return reply.status(200).send({ status: "ok" });
    } catch {
      return reply.status(503).send({ status: "degraded" });
    }
  });

  await registerAuthRoutes(app, {
    pool,
    jwtSecret: config.jwtSecret,
    loginRateLimitMax: config.loginRateLimitMax,
    loginRateLimitWindowMs: config.loginRateLimitWindowMs,
  });
  await registerAuditRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerOrgUnitRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerEmployeeRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerHolidayRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerGeoFenceRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerAttendanceRoutes(app, {
    pool,
    jwtSecret: config.jwtSecret,
    punchRateLimitMax: config.punchRateLimitMax,
    punchRateLimitWindowMs: config.punchRateLimitWindowMs,
  });
  await registerLeaveRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerWorkRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerS5Routes(app, { pool, jwtSecret: config.jwtSecret });
  await registerS6Routes(app, { pool, jwtSecret: config.jwtSecret });
  await registerPayrollRoutes(app, { pool, jwtSecret: config.jwtSecret });

  await registerInventoryRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerPlanningRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerAutomationRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerAnalyticsRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerAdminRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerPayrollDocuments(app, { pool, jwtSecret: config.jwtSecret });
  await registerOrgImport(app,{pool,jwtSecret:config.jwtSecret});
  await registerIntegrationRoutes(app,{pool,jwtSecret:config.jwtSecret});
  await registerJobRoutes(app,{pool,jwtSecret:config.jwtSecret});
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    appConfig: import("./config.js").ApiConfig;
  }
}
