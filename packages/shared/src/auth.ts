import { z } from "zod";

const totpCode = z
  .string()
  .regex(/^\d{6}$/, "TOTP code must be exactly 6 digits");

/** POST /api/v1/auth/login */
export const loginSchema = z.object({
  /**
   * A username or a mobile number (§34).
   *
   * Still called `username` because that is what every client already sends
   * and renaming it would break them all for nothing. What it accepts is
   * wider: a field crew member knows their own number and not the account
   * name somebody generated for them.
   */
  username: z.string().min(1, "Enter your username or mobile number"),
  password: z.string().min(1, "Password is required"),
  /** Required when the account has MFA enabled; omit otherwise. */
  totp_code: totpCode.optional(),
  device_id: z.string().min(8).max(255).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * POST /api/v1/auth/password — setting your own password (§34).
 *
 * The current password is required. A token is far easier to come by than a
 * password -- a shared phone left unlocked is enough -- and without this,
 * holding one would be enough to lock the owner out of their own account.
 *
 * Twelve characters to match what an administrator must already supply when
 * creating an account, so the self-service route cannot be used to weaken a
 * password below what the account was issued with.
 */
export const changePasswordSchema = z.object({
  current_password: z.string().min(1, "Enter your current password"),
  new_password: z.string()
    .min(12, "Use at least 12 characters")
    .max(128, "That is too long"),
}).refine(v => v.current_password !== v.new_password, {
  message: "Choose a password you have not been given",
  path: ["new_password"],
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

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
