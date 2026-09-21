import "./common/env.js";
import { getConfig } from "./config.js";
import { createPool } from "./database/db.js";
import { buildApp } from "./createApp.js";

const config = getConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ pool });

// Every interface unless told otherwise, which is what a container needs. The
// VM sets HOST=127.0.0.1 in its unit, because there nginx is the public door
// and a second way in, without its headers, is one too many.
const host = process.env.HOST?.trim() || "0.0.0.0";

try {
  await app.listen({ port: config.port, host });
  app.log.info(
    { host, port: config.port, node_env: config.nodeEnv },
    "api listening",
  );
} catch (err) {
  app.log.error(err);
  await pool.end();
  process.exit(1);
}

let closing=false;
async function shutdown(){if(closing)return;closing=true;await app.close();await pool.end();}
process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
