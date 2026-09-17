/**
 * Setting your own password (§34).
 *
 * Reached when a password somebody else chose is still in force: an
 * administrator created the account, or reset it. The account is signed in --
 * it has to be, or the password could never be changed -- and every other
 * request comes back 403 until this is done.
 */
import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { changeOwnPassword } from "../../src/api/endpoints";
import { Banner, Button, Input, Muted, Screen, Title } from "../../src/ui/primitives";
import { radius, space, useTheme } from "../../src/theme";

export default function PasswordScreen() {
  const t = useTheme();
  const { logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    // Checked here rather than at the server: a typo in a field nobody can
    // read back is the one mistake worth catching before it locks them out.
    if (next !== confirm) {
      setError("The two new passwords do not match");
      return;
    }
    if (next.length < 12) {
      setError("Use at least 12 characters");
      return;
    }
    if (next === current) {
      setError("Choose a password you have not been given");
      return;
    }
    setBusy(true);
    try {
      await changeOwnPassword(current, next);
      // Every session is gone, this one included. Signing out locally keeps
      // the app from holding a token the server has already revoked.
      await logout();
      router.replace("/(auth)/login");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ alignItems: "center", marginTop: space.xxl * 2, marginBottom: space.xl }}>
        <View
          style={{
            width: 52, height: 52, borderRadius: radius.xl,
            backgroundColor: t.primarySubtle,
            alignItems: "center", justifyContent: "center", marginBottom: space.md,
          }}
        >
          <Ionicons name="key-outline" size={26} color={t.primary} />
        </View>
        <Title>Set your password</Title>
        <Muted style={{ marginTop: 4, textAlign: "center" }}>
          The password you have was chosen by somebody else, so somebody else
          knows it. Choose your own to carry on.
        </Muted>
      </View>

      <Input
        label="Current password"
        placeholder="The one you were given"
        secureTextEntry
        autoCapitalize="none"
        value={current}
        onChangeText={setCurrent}
      />
      <Input
        label="New password"
        placeholder="At least 12 characters"
        secureTextEntry
        autoCapitalize="none"
        value={next}
        onChangeText={setNext}
      />
      <Input
        label="New password again"
        secureTextEntry
        autoCapitalize="none"
        value={confirm}
        onChangeText={setConfirm}
        onSubmitEditing={() => void submit()}
      />

      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}

      <Button
        title="Set password"
        loading={busy}
        onPress={() => void submit()}
        style={{ marginTop: space.md }}
      />
      <Muted style={{ marginTop: space.md, textAlign: "center" }}>
        This signs you out everywhere. Sign in again with your new password.
      </Muted>
    </Screen>
  );
}
