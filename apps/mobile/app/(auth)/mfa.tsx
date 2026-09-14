import { useState } from "react";
import { View } from "react-native";
import { Redirect, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { validateMfaCode } from "../../src/validators";
import { Banner, Button, Input, Muted, Screen, Title } from "../../src/ui/primitives";
import { font, radius, space, useTheme } from "../../src/theme";

export default function MfaScreen() {
  const t = useTheme();
  const { mfaPending, verifyMfa } = useAuth();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const v = validateMfaCode(code.trim());
    if (!v.ok) {
      setError(v.errors[0]?.message ?? "Invalid code");
      return;
    }
    setBusy(true);
    try {
      await verifyMfa(code.trim());
      router.replace("/(tabs)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  // Expo Go can restore the last development route after a reload. An MFA
  // challenge is valid only while AuthProvider still holds the credentials
  // from a login response that explicitly requested MFA.
  if (!mfaPending) return <Redirect href="/(auth)/login" />;

  return (
    <Screen>
      <View style={{ alignItems: "center", marginTop: space.xxl * 2, marginBottom: space.xl }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: radius.xl,
            backgroundColor: t.primarySubtle,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: space.md,
          }}
        >
          <Ionicons name="shield-checkmark-outline" size={26} color={t.primary} />
        </View>
        <Title>Two-factor check</Title>
        <Muted style={{ marginTop: 4, textAlign: "center" }}>
          Enter the 6-digit code from your authenticator app
        </Muted>
      </View>

      <Input
        placeholder="000000"
        keyboardType="number-pad"
        maxLength={6}
        autoFocus
        textContentType="oneTimeCode"
        value={code}
        onChangeText={setCode}
        onSubmitEditing={() => void submit()}
        // Wide tracking makes a 6-digit code readable at a glance on a phone.
        style={{ textAlign: "center", fontSize: font.xxl, letterSpacing: 8, minHeight: 56 }}
      />

      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}

      <Button
        title={busy ? "Verifying…" : "Verify"}
        loading={busy}
        disabled={code.trim().length !== 6}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
