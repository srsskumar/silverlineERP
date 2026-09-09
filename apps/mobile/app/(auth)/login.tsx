import { useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { useForm, Controller } from "react-hook-form";
import { ApiError } from "../../src/api/client";
import { useAuth } from "../../src/auth/AuthContext";
import { validateLogin } from "../../src/validators";
import { useStyles } from "../../src/ui";

interface Form {
  username: string;
  password: string;
}

export default function LoginScreen() {
  const S=useStyles();
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
      router.replace(next === "mfa" ? "/(auth)/mfa" : "/(tabs)");
    } catch (e) {
      if (e instanceof ApiError) {
        const fields = e.fieldErrors
          .map((x) => `${x.field}: ${x.message}`)
          .join("\n");
        setServerError(fields || e.message);
        setRequestId(e.requestId);
      } else {
        setServerError(e instanceof Error ? e.message : "Sign-in failed");
      }
    }
  };

  return (
    <ScrollView contentContainerStyle={S.screen}>
      <Text style={[S.h1, { marginTop: 48 }]}>Silverline ERP</Text>
      <Text style={S.muted}>Sign in with your org account.</Text>
      <View style={{ height: 16 }} />
      <Controller
        control={control}
        name="username"
        render={({ field }) => (
          <TextInput
            style={S.input}
            placeholder="Username"
            autoCapitalize="none"
            value={field.value}
            onChangeText={field.onChange}
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <TextInput
            style={S.input}
            placeholder="Password"
            secureTextEntry
            value={field.value}
            onChangeText={field.onChange}
          />
        )}
      />
      {serverError ? <Text style={S.error}>{serverError}</Text> : null}
      {requestId ? (
        <Text style={S.muted}>request_id: {requestId}</Text>
      ) : null}
      <Pressable
        style={S.btn}
        onPress={handleSubmit(onSubmit)}
        disabled={formState.isSubmitting}
      >
        <Text style={S.btnText}>
          {formState.isSubmitting ? "Signing in…" : "Sign in"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
