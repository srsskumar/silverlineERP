import { z } from "zod";

const totpCode = z
  .string()
  .regex(/^\d{6}$/, "TOTP code must be exactly 6 digits");

/** POST /api/v1/auth/login */
export const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  /** Required when the account has MFA enabled; omit otherwise. */
  totp_code: totpCode.optional(),
  device_id: z.string().min(8).max(255).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** POST /api/v1/auth/refresh */
export const refreshSchema = z.object({
  refresh_token: z.string().min(1, "Refresh token is required"),
});

export type RefreshInput = z.infer<typeof refreshSchema>;

/** POST /api/v1/auth/logout — idempotent; refresh token optional. */
export const logoutSchema = z.object({
  refresh_token: z.string().min(1).optional(),
});

export type LogoutInput = z.infer<typeof logoutSchema>;

/** POST /api/v1/auth/mfa/verify */
export const mfaVerifySchema = z.object({
  code: totpCode,
});

export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export interface AuthTokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  /** Access-token lifetime in seconds (900 = 15 min). */
  expires_in: number;
}

export interface AuthUserSummary {
  id: string;
  username: string;
  org_id: string;
  roles: string[];
}

export interface LoginSuccessResponse extends AuthTokenPair {
  mfa_required: false;
  user: AuthUserSummary;
}

export interface LoginMfaChallengeResponse {
  mfa_required: true;
}

export type LoginResponse = LoginSuccessResponse | LoginMfaChallengeResponse;

export interface MfaSetupResponse {
  /** Base32 TOTP secret (scan or store in authenticator app). */
  secret: string;
  /** otpauth:// URL for QR codes. */
  otpauth_url: string;
}

export interface MeResponse {
  user: {
    id: string;
    username: string;
    email: string | null;
    phone: string | null;
    org_id: string;
    auth_status: string;
    mfa_enabled: boolean;
    last_login_at: string | null;
  };
  roles: string[];
  permissions: string[];
}
