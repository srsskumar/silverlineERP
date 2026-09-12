import { describe, expect, it } from "vitest";
import {
  buildSslOption,
  isLoopbackHost,
  resolveSslMode,
} from "../src/database/db.js";

describe("isLoopbackHost", () => {
  it("recognises every loopback spelling", () => {
    for (const h of ["localhost", "LOCALHOST", "db.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });
  it("treats real hosts as remote", () => {
    for (const h of ["aws-0-ap-south-1.pooler.supabase.com", "10.0.0.5", "db.internal", "1.2.3.4"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe("resolveSslMode", () => {
  // Regression for the shipped bug: both documented local URLs were forced
  // into SSL because the old regex needed `@` or start-of-string before the
  // host, which broke the entire default test run.
  it("disables TLS for local URLs with no username", () => {
    expect(resolveSslMode("postgresql://localhost:5432/silverline_test", {})).toBe("disable");
    expect(resolveSslMode("postgres://127.0.0.1:5432/silverline_dev", {})).toBe("disable");
    expect(resolveSslMode("postgresql://[::1]:5432/x", {})).toBe("disable");
  });

  it("disables TLS for local URLs that do carry a username", () => {
    expect(resolveSslMode("postgresql://user:pw@localhost:5432/x", {})).toBe("disable");
  });

  it("verifies certificates for remote URLs by default", () => {
    expect(resolveSslMode("postgresql://u:p@db.example.com:5432/x", {})).toBe("verify-full");
  });

  it("honours DATABASE_SSL over the URL", () => {
    const url = "postgresql://localhost:5432/x?sslmode=require";
    expect(resolveSslMode(url, {})).toBe("no-verify");
    expect(resolveSslMode(url, { DATABASE_SSL: "disable" })).toBe("disable");
    expect(resolveSslMode(url, { DATABASE_SSL: "verify-full" })).toBe("verify-full");
  });

  it("maps libpq sslmode values", () => {
    const at = (m: string) => resolveSslMode(`postgresql://u@h.example.com/x?sslmode=${m}`, {});
    expect(at("disable")).toBe("disable");
    expect(at("require")).toBe("no-verify");
    expect(at("prefer")).toBe("no-verify");
    expect(at("verify-ca")).toBe("verify-full");
    expect(at("verify-full")).toBe("verify-full");
  });

  it("rejects an unknown DATABASE_SSL value", () => {
    expect(() => resolveSslMode("postgresql://h.example.com/x", { DATABASE_SSL: "yes" })).toThrow(
      /DATABASE_SSL must be/,
    );
  });

  it("refuses unverified TLS in production unless explicitly accepted", () => {
    const url = "postgresql://u:p@db.example.com/x";
    const prod = { NODE_ENV: "production", DATABASE_SSL: "no-verify" };
    expect(() => resolveSslMode(url, prod)).toThrow(/Refusing to start/);
    expect(resolveSslMode(url, { ...prod, DATABASE_SSL_ALLOW_NO_VERIFY: "true" })).toBe("no-verify");
    // Non-production keeps the escape hatch for local proxies/tunnels.
    expect(resolveSslMode(url, { DATABASE_SSL: "no-verify" })).toBe("no-verify");
  });
});

describe("buildSslOption", () => {
  it("returns false when disabled", () => {
    expect(buildSslOption("disable", {})).toBe(false);
  });
  it("verifies against the bundled trust store with no explicit CA", () => {
    expect(buildSslOption("verify-full", {})).toEqual({ rejectUnauthorized: true });
  });
  it("uses an inline CA when provided", () => {
    expect(buildSslOption("verify-full", { DATABASE_CA_CERT: "PEM" })).toEqual({
      rejectUnauthorized: true,
      ca: "PEM",
    });
  });
  it("only skips verification for no-verify", () => {
    expect(buildSslOption("no-verify", {})).toEqual({ rejectUnauthorized: false });
  });
});
