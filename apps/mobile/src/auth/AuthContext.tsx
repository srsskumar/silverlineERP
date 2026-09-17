import {registerDevice} from "../device/registration";
import { useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { AppState,View,Text,Pressable } from "react-native";
import { setActiveAccount, wipeAccount } from "../sync/db";
import { biometricUnlock } from "../device/auth";
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
import { can } from "../rbac";

interface AuthState {
  ready: boolean;
  signedIn: boolean;
  mfaPending: boolean;
  user: MeResponse["user"] | null;
  roles: string[];
  permissions: string[];
  login: (
    username: string, password: string,
  ) => Promise<"ok" | "mfa" | "change-password">;
  verifyMfa: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  canDo: (required: string | readonly string[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Memory-only pending credentials for the MFA step-up call
 * (login { username, password, totp_code }). NEVER persisted — cleared on
 * success, logout, or unmount of the MFA flow.
 */
let pendingCreds: { username: string; password: string } | null = null;

async function loadSession(): Promise<MeResponse | null> {
  // A fresh app launch must require credentials. Tokens are still retained
  // for refresh and API calls during the authenticated session.
  return null;
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
      if(reason==='DEVICE_REVOKED')await wipeAccount().catch(()=>undefined);
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
        setActiveAccount(me.user.id),
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
    const res = await postLogin(username, password);
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
    const res = await postLogin(
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
      login,
      verifyMfa,
      logout,
      canDo: (required) => can(session?.permissions, required),
    }),
    [ready, session, mfaPending, login, verifyMfa, logout],
  );
  return <AuthContext.Provider value={value}>{locked?<View style={{flex:1,justifyContent:'center',padding:30,backgroundColor:'#f4f6fb'}}><Text style={{fontSize:24,marginBottom:20}}>Silverline is locked</Text><Pressable onPress={()=>void biometricUnlock().then(ok=>setLocked(!ok))}><Text style={{fontSize:18,color:'#1a56db'}}>Unlock</Text></Pressable><Pressable onPress={()=>{setLocked(false);void logout();}}><Text style={{marginTop:24}}>Sign out</Text></Pressable></View>:children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
