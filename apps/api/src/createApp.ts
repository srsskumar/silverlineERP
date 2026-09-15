import {buildAuthenticate,requirePermission} from "./common/auth.js";
import {transactionPool} from './common/transactionContext.js';
import {registerOrgImport} from "./modules/org/import.js";
import {registerIntegrationRoutes} from "./modules/integrations/routes.js";
import {registerJobRoutes} from "./modules/jobs/routes.js";
import { registerCrmRoutes } from "./modules/crm/routes.js";
import { registerTenderRoutes } from "./modules/tender/routes.js";
import { registerBillingRoutes } from "./modules/billing/routes.js";
import { registerApprovalRoutes } from "./modules/approvals/routes.js";
import { registerProcurementRoutes } from "./modules/procurement/routes.js";
import { registerExpenseRoutes } from "./modules/expenses/routes.js";
import { registerFinanceRoutes } from "./modules/finance/routes.js";
import { registerStockRoutes } from "./modules/stock/routes.js";
import { registerAllocationRoutes } from "./modules/allocation/routes.js";
import { registerLedgerRoutes } from "./modules/ledgers/routes.js";
import { registerDocumentRoutes } from "./modules/documents/routes.js";
import { registerSurveyRoutes } from "./modules/survey/routes.js";
import { registerAutomationRoutes } from "./modules/automation/routes.js";
import { registerInventoryRoutes } from "./modules/inventory/routes.js";
import { registerPlanningRoutes } from "./modules/planning/routes.js";
import { registerAnalyticsRoutes } from "./modules/analytics/routes.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerPayrollDocuments } from "./modules/payroll/documents.js";
import cors from "@fastify/cors";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { getConfig, originAllowed, type ApiConfigOverrides } from "./config.js";
import { registerRequestId } from "./common/requestId.js";
import { registerErrorHandler } from "./common/httpErrors.js";
import { createPool, describeConnectionError } from "./database/db.js";
import { verifySchemaCurrent } from "./database/schemaGuard.js";
import { scanningDisabled } from "./common/fileSafety.js";
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
  const logger = config.nodeEnv === "test"
    ? false
    : {
        level: config.logLevel,
        redact: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers.set-cookie",
        ],
      };
  const app = Fastify({
    logger,
    // We emit a smaller, stable request/response pair below. This also avoids
    // Fastify's deprecated top-level disableRequestLogging option.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 8 * 1024 * 1024,
  });
  await registerRequestId(app);
  await registerErrorHandler(app);
  const counters=new Map<string,{requests:number;errors:number;total_ms:number}>();
  app.addHook("onRequest", async (req) => {
    req.log.info(
      {
        request_id: req.requestId,
        method: req.method,
        route: req.routeOptions.url ?? req.url.split("?", 1)[0],
      },
      "request received",
    );
  });
  app.addHook('onResponse',async(req,reply)=>{
    const route=req.routeOptions.url??'unmatched',key=req.method+' '+route,m=counters.get(key)??{requests:0,errors:0,total_ms:0};
    m.requests++;if(reply.statusCode>=500)m.errors++;m.total_ms+=reply.elapsedTime;counters.set(key,m);
    const details={request_id:req.requestId,method:req.method,route,status:reply.statusCode,duration_ms:Math.round(reply.elapsedTime)};
    if(reply.statusCode>=500)req.log.error(details,'response sent');
    else req.log.info(details,'response sent');
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
    // A predicate rather than a list, so preview deployments keep working.
    // See originAllowed: patterns must name the project, never all of
    // *.vercel.app, because this API is called with credentials.
    origin(origin, callback) {
      // A missing Origin is a same-origin or non-browser caller (curl, the
      // mobile app); CORS does not apply to those.
      if (!origin) return callback(null, true);
      callback(null, originAllowed(origin, [...config.corsOrigin, ...config.corsPreviewPatterns]));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-ID', 'If-Match', 'X-Record-Version'],
    exposedHeaders: ['x-request-id', 'content-disposition', 'retry-after'],
    credentials: true,
  });
  if (!options.pool) app.addHook('onClose', async () => { await pool.end(); });

  // An un-migrated database does not fail at boot, it fails one route at a
  // time with an opaque 500 the first time a SELECT names a column the
  // database lacks. Name the pending migration once, here, where an operator
  // looks. Boot continues by default (every untouched route still works);
  // REQUIRE_CURRENT_SCHEMA=true turns it into a hard stop for deployments
  // that would rather not serve at all than serve partially broken.
  let schemaOutOfDate = false;
  try {
    const drift = await verifySchemaCurrent(pool, {
      fatal: config.requireCurrentSchema,
      report: (message) => {
        app.log.error({ schema: "out_of_date" }, message);
      },
    });
    schemaOutOfDate = drift.pending.length > 0;
  } catch (error) {
    if (config.requireCurrentSchema) throw error;
    // Unreachable database at boot is the health check's problem, not this
    // check's: report and keep going so /health can explain it properly.
    app.log.error(
      { err: describeConnectionError(error, config.databaseUrl) },
      "could not read schema_migrations at startup",
    );
  }

  // A deployment running without a virus scanner says so once, at boot, where
  // an operator reviewing logs will see it — not silently, and not per upload.
  if (scanningDisabled()) {
    app.log.warn(
      { malware_scanning: "disabled" },
      "MALWARE_SCANNER_DISABLED=true: uploads are checked for a valid file " +
        "signature, extension and size, but are NOT scanned for malware.",
    );
  }

  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      // Connectivity is fine but the build is ahead of the database: surfaced
      // as a field rather than a 503 so liveness probes do not restart-loop.
      return reply
        .status(200)
        .send(schemaOutOfDate ? { status: "ok", schema: "out_of_date" } : { status: "ok" });
    } catch (error) {
      // A bare "degraded" gives an operator nothing to act on; the reason is
      // logged (never returned, since it can name internal hosts) and the most
      // common cause — TLS configuration — is spelled out there.
      app.log.error({ err: describeConnectionError(error, config.databaseUrl) }, "health check failed");
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
  await registerCrmRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerTenderRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerBillingRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerApprovalRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerProcurementRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerExpenseRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerFinanceRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerStockRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerAllocationRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerLedgerRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerDocumentRoutes(app, { pool, jwtSecret: config.jwtSecret });
  await registerSurveyRoutes(app, { pool, jwtSecret: config.jwtSecret });
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
