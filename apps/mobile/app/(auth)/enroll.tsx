import { useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "../../src/api/client";
import { useAuth } from "../../src/auth/AuthContext";
import {
  Banner,
  Button,
  Card,
  Input,
  Muted,
  Screen,
  Subtle,
  Title,
} from "../../src/ui/primitives";
import { font, radius, space, useTheme } from "../../src/theme";

export default function Enroll() {
  const t = useTheme();
  const { logout } = useAuth();
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const startSetup = async () => {
    setBusy(true);
    setMessage("");
    try {
      const r = await apiFetch<{ secret: string }>("/api/v1/auth/mfa/setup", {
        method: "POST",
        body: {},
      });
      setSecret(r.data.secret);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not start setup");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setMessage("");
    try {
      await apiFetch("/api/v1/auth/mfa/verify", { method: "POST", body: { code } });
      await logout();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ alignItems: "center", marginTop: space.xl, marginBottom: space.lg }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: radius.xl,
            backgroundColor: t.warningSubtle,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: space.md,
          }}
        >
          <Ionicons name="lock-closed-outline" size={26} color={t.warning} />
        </View>
        <Title>Secure your account</Title>
        <Muted style={{ marginTop: 4, textAlign: "center" }}>
          Your role requires an authenticator app before you can continue
        </Muted>
      </View>

      <Card>
        {secret ? (
          <>
            <Subtle>Setup key</Subtle>
            <View
              style={{
                backgroundColor: t.surfaceSunken,
                borderRadius: radius.md,
                padding: space.md,
                marginTop: space.xs,
                marginBottom: space.md,
              }}
            >
              {/* Selectable as well as copyable: some authenticators only
                  accept a typed key, and a long-press is not discoverable. */}
              <Text
                selectable
                style={{ fontFamily: "monospace", fontSize: font.base, color: t.text, letterSpacing: 1 }}
              >
                {secret}
              </Text>
            </View>
            <Button
              title={copied ? "Copied" : "Copy setup key"}
              variant="secondary"
              icon={copied ? "checkmark-outline" : "copy-outline"}
              onPress={() => {
                void Clipboard.setStringAsync(secret).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            />
            <Muted style={{ marginTop: space.lg, marginBottom: space.sm }}>
              Add the key to your authenticator app, then enter the six-digit code it shows.
            </Muted>
            <Input
              label="Authentication code"
              placeholder="000000"
              keyboardType="number-pad"
              maxLength={6}
              value={code}
              onChangeText={setCode}
              style={{ textAlign: "center", letterSpacing: 6 }}
            />
            <Button
              title={busy ? "Enabling…" : "Enable and sign in again"}
              loading={busy}
              disabled={code.trim().length !== 6}
              onPress={() => void confirm()}
            />
          </>
        ) : (
          <>
            <Muted style={{ marginBottom: space.md }}>
              Silverline will show you a setup key to add to an authenticator app such as
              Google Authenticator or 1Password.
            </Muted>
            <Button
              title="Set up authenticator"
              icon="key-outline"
              loading={busy}
              onPress={() => void startSetup()}
            />
          </>
        )}
        {message ? (
          <View style={{ marginTop: space.md }}>
            <Banner tone="danger" icon="alert-circle-outline" title={message} />
          </View>
        ) : null}
      </Card>

      <Button title="Sign out" variant="ghost" onPress={() => void logout()} />
    </Screen>
  );
}
