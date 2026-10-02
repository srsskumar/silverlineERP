import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, type FieldError } from "@silverline/shared";

export interface ErrorBody {
  status: number;
  code: string;
  message: string;
  fieldErrors?: FieldError[];
  retryable?: boolean;
}

export function sendError(
  reply: FastifyReply,
  requestId: string,
  body: ErrorBody,
): FastifyReply {
  const retryable = body.retryable ?? (body.status === 429 || body.status >= 500);
  return reply.status(body.status).send({
    code: body.code,
    message: body.message,
    field_errors: body.fieldErrors ?? [],
    request_id: requestId,
    retryable,
  });
}

/** Centralized error envelope: ApiError passthrough, safe 500 fallback. */
export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, req: FastifyRequest, reply) => {
    const requestId = req.requestId ?? "unknown";
    if (err instanceof ApiError) {
      return sendError(reply, requestId, {
        status: err.status,
        code: err.code,
        message: err.message,
        fieldErrors: err.fieldErrors,
        retryable: err.retryable,
      });
    }
    const databaseCode=(err as {code?:string}).code;
    if(databaseCode==='40P01'||databaseCode==='40001')return sendError(reply,requestId,{status:503,code:'RETRY_TRANSACTION',message:'A simultaneous change occurred. Retry using the same operation key.',retryable:true});
    if(databaseCode==='23505')return sendError(reply,requestId,{status:409,code:'DUPLICATE_RECORD',message:'A record with this identifier already exists'});
    if(databaseCode==='23503'||databaseCode==='23514')return sendError(reply,requestId,{status:422,code:'VALIDATION_ERROR',message:'A referenced record or value is invalid'});
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    // Postgres 22P02 (invalid_text_representation): malformed UUID/numeric in
    // path params or casts. Client bug, never a 500 — envelope as 422.
    if ((err as { code?: unknown }).code === "22P02") {
      return sendError(reply, requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: [{ field: "id", message: "Malformed resource id" }],
      });
    }
    // 22007/22008 (invalid_datetime_format / datetime_field_overflow):
    // a date that matches the shared schema's YYYY-MM-DD shape but names no
    // real calendar day, e.g. 2026-02-31. The regex checks the shape, not
    // the calendar; Postgres is what actually knows February has 28 days.
    // 22003 (numeric_value_out_of_range): an amount/quantity bigger than the
    // column's NUMERIC precision. Both are a client-supplied value Postgres
    // refused, never a server bug — envelope as 422, not 500.
    if (["22007", "22008", "22003"].includes(String((err as { code?: unknown }).code))) {
      return sendError(reply, requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: [{ field: "value", message: "That date or number is not valid" }],
      });
    }
    if (status >= 500) {
      req.log.error({ error_type:err instanceof Error?err.name:"Error",code:databaseCode,requestId }, "unhandled error");
      return sendError(reply, requestId, {
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      });
    }
    // 4xx from Fastify core (bad JSON, unknown content type, ...): envelope it,
    // never leak internals.
    return sendError(reply, requestId, {
      status,
      code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
      message: status === 404 ? "Not found" : "Bad request",
    });
  });

  app.setNotFoundHandler((req, reply) => {
    sendError(reply, req.requestId ?? "unknown", {
      status: 404,
      code: "NOT_FOUND",
      message: "Not found",
    });
  });
}
