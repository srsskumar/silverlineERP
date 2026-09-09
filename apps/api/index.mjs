/**
 * Vercel Fastify entry. Vercel's framework="fastify" preset auto-detects
 * the entrypoint only at these exact locations: app|index|server at the
 * project root or under src/. Kept as plain JavaScript (not .ts) so
 * @vercel/node doesn't recompile it with the API tsconfig (that path
 * reports "src/app.ts: Emit skipped" after a successful turbo build).
 *
 * The `fastify` import below is required even though it's unused directly:
 * Vercel's build-time detector only checks this file's own source for a
 * "fastify" import to confirm it's a Fastify entrypoint — it doesn't follow
 * into dist/createApp.js, which is where the app is actually constructed.
 *
 * Serverless functions can't bind a real listening socket, so this calls
 * app.ready() (finishes plugin/route registration) instead of app.listen()
 * — Vercel's runtime dispatches requests into the exported instance
 * directly. Calling listen() here hung every request indefinitely, since
 * its promise never resolves in the sandbox.
 */
import "fastify";
import "./dist/common/env.js";
import { getConfig } from "./dist/config.js";
import { createPool } from "./dist/database/db.js";
import { buildApp } from "./dist/createApp.js";

const config = getConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ pool });

await app.ready();

export default app;
