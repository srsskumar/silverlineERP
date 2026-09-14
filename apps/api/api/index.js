/**
 * Serverless entry point for the API.
 *
 * `src/main.ts` boots the same Fastify app with `app.listen()`, which a
 * serverless host cannot run: there is no long-lived process to listen. This
 * module builds the app once per cold start and hands each incoming request to
 * Fastify's own HTTP server object, so every route, hook, error envelope and
 * permission check behaves exactly as it does under `npm start`.
 *
 * It imports from `dist/` rather than `src/`: the build runs `tsc` first (see
 * vercel.json), so what ships is the same compiled output the container image
 * uses, not a second compilation with different settings.
 */

let appPromise;

/**
 * Builds the app once and reuses it for every request this instance serves.
 *
 * A rejected boot is not cached: a cold start that fails on, say, an unreachable
 * database would otherwise poison the instance for its whole lifetime, turning
 * one bad moment into sustained downtime.
 */
async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const { buildApp } = await import("../dist/createApp.js");
      const app = await buildApp();
      await app.ready();
      return app;
    })().catch((error) => {
      appPromise = undefined;
      throw error;
    });
  }
  return appPromise;
}

export default async function handler(req, res) {
  let app;
  try {
    app = await getApp();
  } catch (error) {
    // Boot failed — say so in the API's own envelope rather than letting the
    // platform return an opaque 500 page a client cannot parse.
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        code: "SERVICE_UNAVAILABLE",
        message: "The API could not start. Check DATABASE_URL and secrets.",
        field_errors: [],
        request_id: "boot",
        retryable: true,
      }),
    );
    if (process.env.NODE_ENV !== "production") console.error(error);
    return;
  }
  // Fastify's router is an http.Server listener; emitting "request" runs the
  // full pipeline without binding a port.
  app.server.emit("request", req, res);
}
