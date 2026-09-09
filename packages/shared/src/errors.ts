import { z } from "zod";

export const fieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * Standard API error envelope: { code, message, field_errors, request_id, retryable }
 * (ARCHITECTURE.md §5.1, DEV_PLAN.md §1).
 */
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  field_errors: z.array(fieldErrorSchema).default([]),
  request_id: z.string(),
  retryable: z.boolean(),
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorSchema>;

export interface ApiErrorOptions {
  status: number;
  code: string;
  message: string;
  fieldErrors?: FieldError[];
  retryable?: boolean;
}

/** Typed server-side error that maps 1:1 onto the envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: FieldError[];
  readonly retryable: boolean;

  constructor(opts: ApiErrorOptions) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.fieldErrors = opts.fieldErrors ?? [];
    this.retryable = opts.retryable ?? (opts.status === 429 || opts.status >= 500);
  }

  toEnvelope(requestId: string): ApiErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      field_errors: this.fieldErrors,
      request_id: requestId,
      retryable: this.retryable,
    };
  }
}

export function toFieldErrors(err: z.ZodError): FieldError[] {
  return err.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
    code: issue.code,
  }));
}
