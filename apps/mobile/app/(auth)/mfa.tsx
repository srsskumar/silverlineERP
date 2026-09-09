import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { router } from "expo-router";
import { useAuth } from "../../src/auth/AuthContext";
import { validateMfaCode } from "../../src/validators";
import { useStyles } from "../../src/ui";

export default function MfaScreen() {
  const S=useStyles();
  const { verifyMfa } = useAuth();
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

  return (
    <ScrollView contentContainerStyle={S.screen}>
      <Text style={[S.h1, { marginTop: 48 }]}>Two-factor check</Text>
      <Text style={S.muted}>
        Enter the 6-digit code from your authenticator app.
      </Text>
      <TextInput
        style={[S.input, { marginTop: 16 }]}
        placeholder="123456"
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={setCode}
      />
      {error ? <Text style={S.error}>{error}</Text> : null}
      <Pressable style={S.btn} onPress={submit} disabled={busy}>
        <Text style={S.btnText}>{busy ? "Verifying…" : "Verify"}</Text>
      </Pressable>
    </ScrollView>
  );
}
