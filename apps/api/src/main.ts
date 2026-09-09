import "./common/env.js";
import { getConfig } from "./config.js";
import { createPool } from "./database/db.js";
import { buildApp } from "./app.js";

const config = getConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ pool });

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`api listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  await pool.end();
  process.exit(1);
}

let closing=false;
async function shutdown(){if(closing)return;closing=true;await app.close();await pool.end();}
process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
