import {registerDevice} from "../device/registration";
import { useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { AppState,View,Text,Pressable } from "react-native";
import { setActiveAccount, wipeAccount, wipeUsername } from "../sync/db";
import { DEVICE_REVOKED, isDeviceRevoked } from "../api/revocation";
import { biometricUnlock } from "../device/auth";
import { useTheme } from "../theme";
/**
 * AuthProvider: login / MFA / refresh / logout + user/roles/permissions.
 * Tokens in SecureStore only. Registers the api client's logout hook so a
 * dead refresh forces sign-out everywhere.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { router } from "expo-router";
import { onAuthLogout } from "../api/client";
import { getMe, postLogin, type MeResponse } from "../api/endpoints";
import {
  clearTokens,
  getRefreshToken,
  saveTokens,
} from "../device/auth";
import { can, canSeeModule } from "../rbac";

interface AuthState {
  ready: boolean;
  signedIn: boolean;
  mfaPending: boolean;
  user: MeResponse["user"] | null;
  roles: string[];
  permissions: string[];
  /** The admin-configured nav-visibility map from /auth/me. See rbac.ts. */
  modules: Record<string, boolean> | undefined;
  login: (
    username: string, password: string,
  ) => Promise<"ok" | "mfa" | "change-password">;
  verifyMfa: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  canDo: (required: string | readonly string[]) => boolean;
  /** Whether this user's roles show module `code` as visible. UI-only — see rbac.ts. */
  canSeeModule: (code: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Memory-only pending credentials for the MFA step-up call
 * (login { username, password, totp_code }). NEVER persisted — cleared on
 * success, logout, or unmount of the MFA flow.
 */
let pendingCreds: { username: string; password: string } | null = null;

/**
 * Restore a session left from a previous launch, so signing in once is
 * enough until somebody chooses to sign out -- a field crew re-typing a
 * password every time the phone locks its screen is the opposite of what
 * this app is for.
 *
 * The cached copy is trusted immediately -- a field phone is offline as
 * often as not, and refusing to open the app until the network confirms a
 * session is exactly the offline-first promise this app breaks otherwise.
 * `getMe()` still runs in the background to catch a session that died
 * server-side (password changed, role changed, device revoked) while this
 * device was away; if the server actively rejects it, the api client's own
 * 401 handling already fires onAuthLogout and clears everything, so nothing
 * further is needed here for that case.
 */
async function loadSession(): Promise<MeResponse | null> {
  const cachedRaw = await SecureStore.getItemAsync("silverline.session").catch(() => null);
  if (!cachedRaw) return null;
  let cached: MeResponse;
  try {
    cached = JSON.parse(cachedRaw) as MeResponse;
  } catch {
    return null;
  }
  void getMe()
    .then((fresh) => {
      void SecureStore.setItemAsync("silverline.session", JSON.stringify(fresh)).catch(() => undefined);
    })
    // Nothing to do here either way: a network failure says nothing about
    // whether the session is still good, and a real rejection (expired
    // refresh, device revoked) is already handled by the api client's own
    // 401 path, which calls onAuthLogout and clears everything itself.
    .catch(() => undefined);
  return cached;
}

/**
 * Login, and the login-time half of a remote wipe. A revoked device is refused
 * at the door, before there is a session or an account id to wipe by, so the
 * username is what identifies whose data on this device has to go.
 */
async function postLoginOrWipe(
  username: string,
  password: string,
  totpCode?: string,
): ReturnType<typeof postLogin> {
  try {
    return await postLogin(username, password, totpCode);
  } catch (error) {
    if (isDeviceRevoked(error)) await wipeUsername(username).catch(() => undefined);
    throw error;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<MeResponse | null>(null);
  const [mfaPending, setMfaPending] = useState(false);
  const [locked,setLocked]=useState(false);
  useEffect(()=>{
    let inactiveAt=Date.now(),unlocking=false;
    const sub=AppState.addEventListener('change',state=>{
      if(unlocking)return;
      if(state!=='active'){inactiveAt=Date.now();return;}
      if(session&&Date.now()-inactiveAt>=5*60*1000){setLocked(true);unlocking=true;void biometricUnlock().then(ok=>setLocked(!ok)).finally(()=>{unlocking=false;});}
    });
    return ()=>sub.remove();
  },[session]);

  useEffect(() => {
    onAuthLogout(async reason => {
      pendingCreds = null;
      queryClient.clear();
      if(reason===DEVICE_REVOKED)await wipeAccount().catch(()=>undefined);
      // Ordinary expiry retains the encrypted outbox for the same account.
      await SecureStore.deleteItemAsync('silverline.session');
      await setActiveAccount(null);
      setSession(null);
      setMfaPending(false);
      router.replace("/(auth)/login");
    });
    void loadSession()
      .then((s) => setSession(s))
      .catch(() => setSession(null))
      .finally(() => setReady(true));
    return () => onAuthLogout(null);
  }, []);

  const completeSignIn = useCallback(async (accessToken: string, refreshToken: string) => {
    try {
      await saveTokens(accessToken, refreshToken);
      const me = await getMe();
      queryClient.clear();
      await Promise.all([
        setActiveAccount(me.user.id, me.user.username),
        SecureStore.setItemAsync('silverline.session', JSON.stringify(me)),
        SecureStore.setItemAsync('silverline.session_at', String(Date.now())),
      ]);
      setSession(me);
      // Registration is useful metadata, but login must not remain blocked if
      // this non-critical follow-up is slow. Revoked devices are already
      // rejected by /auth/login using the same device_id.
      void registerDevice().catch((error) => {
        console.warn('[auth] device registration failed', error instanceof Error ? error.message : error);
      });
    } catch (error) {
      await clearTokens();
      throw error;
    }
  }, [queryClient]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await postLoginOrWipe(username, password);
    if (res.mfa_required) {
      pendingCreds = { username, password };
      setMfaPending(true);
      return "mfa" as const;
    }
    pendingCreds = null;
    setMfaPending(false);
    await completeSignIn(res.access_token, res.refresh_token);
    // A password somebody else chose. Signed in — it has to be, or the
    // password could never be changed — but every other request comes back
    // 403 until it is (§34).
    if ((res as { must_change_password?: boolean }).must_change_password) {
      return "change-password" as const;
    }
    return "ok" as const;
  }, [completeSignIn]);

  const verifyMfa = useCallback(async (code: string) => {
    if (!pendingCreds) throw new Error("MFA session expired — sign in again");
    const res = await postLoginOrWipe(
      pendingCreds.username,
      pendingCreds.password,
      code,
    );
    if (res.mfa_required) throw new Error("Code not accepted — try again");
    pendingCreds = null;
    setMfaPending(false);
    await completeSignIn(res.access_token, res.refresh_token);
  }, [completeSignIn]);

  const logout = useCallback(async () => {
    pendingCreds = null;
    const rt = await getRefreshToken().catch(() => null);
    const { postLogout } = await import("../api/endpoints");
    await postLogout(rt ?? undefined);
    await clearTokens();
    queryClient.clear();
    await SecureStore.deleteItemAsync('silverline.session');
    await setActiveAccount(null);
    setSession(null);
    setMfaPending(false);
    router.replace("/(auth)/login");
  }, []);


  const value = useMemo<AuthState>(
    () => ({
      ready,
      signedIn: session !== null,
      mfaPending,
      user: session?.user ?? null,
      roles: session?.roles ?? [],
      permissions: session?.permissions ?? [],
      modules: session?.modules,
      login,
      verifyMfa,
      logout,
      canDo: (required) => can(session?.permissions, required),
      canSeeModule: (code) => canSeeModule(session?.modules, code),
    }),
    [ready, session, mfaPending, login, verifyMfa, logout],
  );
  return <AuthContext.Provider value={value}>{locked?<LockedScreen onUnlock={()=>void biometricUnlock().then(ok=>setLocked(!ok))} onSignOut={()=>{setLocked(false);void logout();}}/>:children}</AuthContext.Provider>;
}

/**
 * The lock screen follows the system theme like every other screen: it used
 * to be the one light-only view in the app, a white flash over a dark app
 * every time the phone came back from the pocket.
 */
function LockedScreen({ onUnlock, onSignOut }: { onUnlock: () => void; onSignOut: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 30, backgroundColor: t.canvas }}>
      <Text style={{ fontSize: 24, marginBottom: 20, color: t.text }}>Silverline is locked</Text>
      <Pressable onPress={onUnlock}><Text style={{ fontSize: 18, color: t.primary }}>Unlock</Text></Pressable>
      <Pressable onPress={onSignOut}><Text style={{ marginTop: 24, color: t.textMuted }}>Sign out</Text></Pressable>
    </View>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
