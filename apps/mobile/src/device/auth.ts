/**
 * Secure token + biometric-gate store.
 *
 * SECURITY: tokens live ONLY in expo-secure-store (Keychain/Keystore).
 * NEVER persist tokens in expo-sqlite, AsyncStorage, or logs.
 */

import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

const ACCESS_KEY = "silverline.access_token";
const REFRESH_KEY = "silverline.refresh_token";
const BIO_KEY = "silverline.biometric_enabled";

export async function saveTokens(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
}

export async function getAccessToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ACCESS_KEY);
  } catch {
    return null;
  }
}

export async function getRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_KEY);
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => undefined);
}

export interface BiometricState {
  hardware: boolean;
  enrolled: boolean;
  enabled: boolean;
}

export async function getBiometricState(): Promise<BiometricState> {
  const [hardware, enrolled, enabled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync().catch(() => false),
    LocalAuthentication.isEnrolledAsync().catch(() => false),
    SecureStore.getItemAsync(BIO_KEY)
      .then((v) => v === "1")
      .catch(() => false),
  ]);
  return { hardware, enrolled, enabled };
}

export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    const ok = await LocalAuthentication.authenticateAsync({
      promptMessage: "Enable biometric unlock",
      disableDeviceFallback: false,
    });
    if (!ok.success) throw new Error("Biometric enrolment was not confirmed");
  }
  await SecureStore.setItemAsync(BIO_KEY, enabled ? "1" : "0");
}

/** Gate app foreground unlock when the user enabled biometrics. */
export async function biometricUnlock(): Promise<boolean> {
  const state = await getBiometricState();
  if (!state.enabled) return true;
  if (!state.hardware || !state.enrolled) return false;
  const res = await LocalAuthentication.authenticateAsync({
    promptMessage: "Unlock Silverline",
    disableDeviceFallback: false,
  });
  return res.success;
}

// The operating system credential fallback is enabled in authenticateAsync.
