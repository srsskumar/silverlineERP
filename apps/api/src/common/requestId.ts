import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

/**
 * Generates (or echoes the inbound) request id and echoes it back via the
 * `x-request-id` response header. Every error envelope carries the same id.
 */
export async function registerRequestId(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    const inbound = req.headers["x-request-id"];
    const requestId =
      (Array.isArray(inbound) ? inbound[0] : inbound)?.trim().slice(0,100) || randomUUID();
    req.requestId = requestId;
    reply.header("x-request-id", requestId);
  });
}
