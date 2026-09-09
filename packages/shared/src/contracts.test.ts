import { describe, expect, it } from "vitest";
import { loginSchema, refreshSchema, mfaVerifySchema } from "./auth.js";
import { can, PERMISSIONS, ROLE_CODES, ROLE_PERMISSIONS } from "./rbac.js";
import {
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
} from "./pagination.js";
import {
  createIdempotencyKey,
  isSyncTerminalState,
  isValidIdempotencyKey,
} from "./sync.js";

describe("auth schemas", () => {
  it("accepts a valid login body", () => {
    expect(
      loginSchema.safeParse({ username: "admin", password: "x" }).success,
    ).toBe(true);
  });

  it("rejects login with missing password", () => {
    const res = loginSchema.safeParse({ username: "admin" });
    expect(res.success).toBe(false);
  });

  it("rejects malformed totp_code", () => {
    expect(
      loginSchema.safeParse({ username: "a", password: "b", totp_code: "12" })
        .success,
    ).toBe(false);
    expect(
      loginSchema.safeParse({ username: "a", password: "b", totp_code: "123456" })
        .success,
    ).toBe(true);
  });

  it("mfaVerify requires 6 digits; refresh requires a token", () => {
    expect(mfaVerifySchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(mfaVerifySchema.safeParse({ code: "abc" }).success).toBe(false);
    expect(refreshSchema.safeParse({ refresh_token: "tok" }).success).toBe(true);
    expect(refreshSchema.safeParse({}).success).toBe(false);
  });
});

describe("rbac", () => {
  it("seeds all listed role codes", () => {
    for (const code of [
      "SUPER_ADMIN",
      "ADMIN",
      "PAYROLL_OFFICER",
      "INVENTORY_MANAGER",
      "HR_MANAGER",
      "PROJECT_MANAGER",
      "TEAM_LEAD",
      "EMPLOYEE",
      "CLIENT_VIEWER",
      "AUDITOR",
    ]) {
      expect(ROLE_CODES).toContain(code);
    }
  });

  it("super_admin has audit.read; employee does not", () => {
    expect(can(ROLE_PERMISSIONS.SUPER_ADMIN, PERMISSIONS.AUDIT_READ)).toBe(true);
    expect(can(ROLE_PERMISSIONS.EMPLOYEE, PERMISSIONS.AUDIT_READ)).toBe(false);
  });

  it("can() supports a list (all-must-match)", () => {
    expect(can(["a", "b"], ["a", "b"])).toBe(true);
    expect(can(["a"], ["a", "b"])).toBe(false);
  });
});

describe("pagination + sync", () => {
  it("defaults limit to 20 and caps at 100", () => {
    expect(cursorPageQuerySchema.parse({}).limit).toBe(20);
    expect(cursorPageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("cursor encode/decode round-trips; garbage returns null", () => {
    const c = encodeCursor({ created_at: "2024-01-01", id: "abc" });
    expect(decodeCursor(c)).toEqual({ created_at: "2024-01-01", id: "abc" });
    expect(decodeCursor("!!!not-a-cursor!!!")).toBeNull();
  });

  it("idempotency keys are unique and valid; terminal states", () => {
    const a = createIdempotencyKey();
    const b = createIdempotencyKey();
    expect(a).not.toBe(b);
    expect(isValidIdempotencyKey(a)).toBe(true);
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isSyncTerminalState("SYNCED")).toBe(true);
    expect(isSyncTerminalState("QUEUED")).toBe(false);
  });
});
