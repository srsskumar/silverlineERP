/**
 * Vercel Fastify entry. Keep this file as plain JavaScript so @vercel/node
 * does not recompile TypeScript with the API tsconfig (that path reports
 * "src/app.ts: Emit skipped" after a successful turbo build).
 */
import "../dist/common/env.js";
import { getConfig } from "../dist/config.js";
import { createPool } from "../dist/database/db.js";
import { buildApp } from "../dist/createApp.js";

const config = getConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ pool });

await app.listen({
  port: Number(process.env.PORT ?? config.port),
  host: "0.0.0.0",
});

export default app;
