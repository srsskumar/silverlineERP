import { DEV_DEFAULT_ENCRYPTION_KEY } from "./common/crypto.js";

export interface ApiConfig {
  databaseUrl: string;
  jwtSecret: string;
  port: number;
  /** Allowed browser origins (CORS). Comma-separated in CORS_ORIGIN env. */
  corsOrigin: string[];
  nodeEnv: string;
  bcryptRounds: number;
  /** Max login attempts per IP per window (S0: 10/min/IP). */
  loginRateLimitMax: number;
  loginRateLimitWindowMs: number;
  /** Max attendance punches per authed user (else IP) per window (S6: 30/min). */
  punchRateLimitMax: number;
  punchRateLimitWindowMs: number;
  /**
   * 32-byte hex key for AES-256-GCM PII encryption. Documented dev default
   * in the README; set a real secret in every other environment. Never log.
   */
  encryptionKey: string;
  /** Local document storage root (S1 driver; R2 presigned deferred). */
  uploadsDir: string;
}

export interface ApiConfigOverrides {
  databaseUrl?: string;
  jwtSecret?: string;
  port?: number;
  corsOrigin?: string[];
  nodeEnv?: string;
  bcryptRounds?: number;
  loginRateLimitMax?: number;
  loginRateLimitWindowMs?: number;
  punchRateLimitMax?: number;
  punchRateLimitWindowMs?: number;
  encryptionKey?: string;
  uploadsDir?: string;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

/** Split a comma-separated origin list; undefined when unset/empty. */
function parseOrigins(raw: string | undefined): string[] | undefined {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

export function getConfig(overrides: ApiConfigOverrides = {}): ApiConfig {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const jwtSecret = overrides.jwtSecret ?? required('JWT_SECRET', 'dev-secret-change-me');
  const encryptionKey = overrides.encryptionKey ?? required('ENCRYPTION_KEY', DEV_DEFAULT_ENCRYPTION_KEY);
  if (nodeEnv === 'production') {
    if (jwtSecret.length < 32 || jwtSecret === 'dev-secret-change-me') throw new Error('Production JWT_SECRET must contain at least 32 characters');
    if (!/^[a-f0-9]{64}$/i.test(encryptionKey) || encryptionKey === DEV_DEFAULT_ENCRYPTION_KEY) throw new Error('Production ENCRYPTION_KEY must be a private 32-byte hex key');
    if (!overrides.databaseUrl && !process.env.DATABASE_URL) throw new Error('Production DATABASE_URL is required');
  }
  return {
    databaseUrl:
      overrides.databaseUrl ??
      required("DATABASE_URL", "postgresql://localhost:5432/silverline_dev"),
    jwtSecret,
    port: overrides.port ?? Number(process.env["PORT"] ?? 3101),
    corsOrigin: overrides.corsOrigin ?? parseOrigins(process.env["CORS_ORIGIN"]) ?? [
      "http://localhost:3000",
      "http://localhost:3002",
    ],
    nodeEnv: overrides.nodeEnv ?? process.env["NODE_ENV"] ?? "development",
    bcryptRounds: overrides.bcryptRounds ?? Number(process.env["BCRYPT_ROUNDS"] ?? 10),
    loginRateLimitMax:
      overrides.loginRateLimitMax ??
      Number(process.env["LOGIN_RATE_LIMIT_MAX"] ?? 10),
    loginRateLimitWindowMs:
      overrides.loginRateLimitWindowMs ?? 60_000,
    punchRateLimitMax:
      overrides.punchRateLimitMax ??
      Number(process.env["PUNCH_RATE_LIMIT_MAX"] ?? 30),
    punchRateLimitWindowMs:
      overrides.punchRateLimitWindowMs ?? 60_000,
    encryptionKey:
      overrides.encryptionKey ??
      required("ENCRYPTION_KEY", DEV_DEFAULT_ENCRYPTION_KEY),
    uploadsDir:
      overrides.uploadsDir ?? process.env["UPLOADS_DIR"] ?? "./uploads",
  };
}
