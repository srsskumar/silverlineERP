import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useForm, Controller } from "react-hook-form";
import { Ionicons } from "@expo/vector-icons";
import { ApiError } from "../../src/api/client";
import { useAuth } from "../../src/auth/AuthContext";
import { validateLogin } from "../../src/validators";
import { Banner, Button, Input, Muted, Screen, Subtle, Title } from "../../src/ui/primitives";
import { radius, space, useTheme } from "../../src/theme";

interface Form {
  username: string;
  password: string;
}

export default function LoginScreen() {
  const t = useTheme();
  const { login } = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const { control, handleSubmit, formState } = useForm<Form>({
    defaultValues: { username: "", password: "" },
  });

  const onSubmit = async (f: Form) => {
    setServerError(null);
    setRequestId(null);
    const v = validateLogin(f);
    if (!v.ok) {
      setServerError(v.errors.map((e) => `${e.field}: ${e.message}`).join("\n"));
      return;
    }
    try {
      const next = await login(f.username.trim(), f.password);
      if (next === "mfa") router.replace("/(auth)/mfa");
      else if (next === "change-password") router.replace("/(auth)/password");
      else router.replace("/(tabs)");
    } catch (e) {
      if (e instanceof ApiError) {
        const fields = e.fieldErrors.map((x) => `${x.field}: ${x.message}`).join("\n");
        setServerError(fields || e.message);
        setRequestId(e.requestId);
      } else {
        setServerError(e instanceof Error ? e.message : "Sign-in failed");
      }
    }
  };

  return (
    <Screen>
      <View style={{ alignItems: "center", marginTop: space.xxl * 2, marginBottom: space.xl }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: radius.xl,
            backgroundColor: t.primary,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: space.md,
          }}
        >
          <Ionicons name="layers-outline" size={26} color={t.primaryFg} />
        </View>
        <Title>Silverline ERP</Title>
        <Muted style={{ marginTop: 4 }}>Sign in with your organisation account</Muted>
      </View>

      <Controller
        control={control}
        name="username"
        render={({ field }) => (
          <Input
            label="Username or mobile number"
            placeholder="Your mobile number"
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="username"
            returnKeyType="next"
            value={field.value}
            onChangeText={field.onChange}
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <Input
            label="Password"
            placeholder="Your password"
            secureTextEntry
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={handleSubmit(onSubmit)}
            value={field.value}
            onChangeText={field.onChange}
          />
        )}
      />

      {serverError ? (
        <Banner tone="danger" icon="alert-circle-outline" title="Sign-in failed" message={serverError} />
      ) : null}
      {requestId ? <Subtle>Reference: {requestId}</Subtle> : null}

      <Button
        title={formState.isSubmitting ? "Signing in…" : "Sign in"}
        loading={formState.isSubmitting}
        onPress={handleSubmit(onSubmit)}
        style={{ marginTop: space.sm }}
      />
    </Screen>
  );
}
