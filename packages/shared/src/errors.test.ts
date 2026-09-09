import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  ApiError,
  toFieldErrors,
} from "./errors.js";
import { z } from "zod";

describe("error envelope", () => {
  it("accepts a well-formed envelope", () => {
    const parsed = apiErrorSchema.safeParse({
      code: "INVALID_CREDENTIALS",
      message: "Invalid username or password",
      field_errors: [],
      request_id: "req-123",
      retryable: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an envelope missing request_id", () => {
    const parsed = apiErrorSchema.safeParse({
      code: "X",
      message: "y",
      field_errors: [],
      retryable: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("ApiError.toEnvelope() round-trips through the schema", () => {
    const err = new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      fieldErrors: [{ field: "password", message: "Required" }],
    });
    const envelope = err.toEnvelope("req-1");
    expect(apiErrorSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.retryable).toBe(false);
  });

  it("marks 429/5xx as retryable and 4xx as not", () => {
    expect(new ApiError({ status: 429, code: "X", message: "y" }).retryable).toBe(true);
    expect(new ApiError({ status: 500, code: "X", message: "y" }).retryable).toBe(true);
    expect(new ApiError({ status: 401, code: "X", message: "y" }).retryable).toBe(false);
  });

  it("toFieldErrors maps zod issues to {field,message}", () => {
    const schema = z.object({ password: z.string().min(1) });
    const res = schema.safeParse({});
    expect(res.success).toBe(false);
    if (!res.success) {
      const fes = toFieldErrors(res.error);
      expect(fes).toHaveLength(1);
      expect(fes[0]?.field).toBe("password");
    }
  });
});
