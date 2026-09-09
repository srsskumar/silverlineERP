/** Tiny shared primitives so every screen file stays focused. */
import type { ReactNode } from "react";
import { StyleSheet, Text, View, useColorScheme } from "react-native";

export const C = {
  bg: "#f4f6fb",
  card: "#ffffff",
  ink: "#111827",
  muted: "#6b7280",
  primary: "#1a56db",
  danger: "#dc2626",
  ok: "#15803d",
  warn: "#b45309",
  line: "#e5e7eb",
};

const DARK = {...C,bg:"#111827",card:"#1f2937",ink:"#f9fafb",muted:"#cbd5e1",primary:"#93c5fd",line:"#475569",danger:"#fca5a5"};
const makeStyles=(C:typeof DARK)=>StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, padding: 16 },
  card: {
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.line,
  },
  h1: { fontSize: 22, fontWeight: "700", color: C.ink, marginBottom: 12 },
  h2: { fontSize: 16, fontWeight: "700", color: C.ink, marginBottom: 8 },
  body: { fontSize: 14, color: C.ink },
  muted: { fontSize: 13, color: C.muted },
  error: { fontSize: 13, color: C.danger, marginTop: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: C.ink,
    marginBottom: 4,
  },
  btn: {
    backgroundColor: C.primary,
    borderRadius: 10,
    padding: 13,
    alignItems: "center",
    marginTop: 10,
  },
  btnText: { color: C.bg==="#111827"?"#111827":"#fff", fontWeight: "700", fontSize: 15 },
  btnGhost: {
    borderRadius: 10,
    padding: 13,
    alignItems: "center",
    marginTop: 10,
    borderWidth: 1,
    borderColor: C.primary,
  },
  btnGhostText: { color: C.primary, fontWeight: "700", fontSize: 15 },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  pillText: { fontSize: 12, fontWeight: "700" },
});

export const S=makeStyles(C);
const darkStyles=makeStyles(DARK);
export function useColors(){return useColorScheme()==='dark'?DARK:C;}
export function useStyles(){return useColorScheme()==='dark'?darkStyles:S;}

export function Pill({
  text,
  tone,
}: {
  text: string;
  tone: "ok" | "warn" | "bad" | "info";
}) {
  const S=useStyles();
  const bg =
    tone === "ok"
      ? "#dcfce7"
      : tone === "warn"
        ? "#fef3c7"
        : tone === "bad"
          ? "#fee2e2"
          : "#dbeafe";
  const fg =
    tone === "ok"
      ? C.ok
      : tone === "warn"
        ? C.warn
        : tone === "bad"
          ? C.danger
          : C.primary;
  return (
    <View style={[S.pill, { backgroundColor: bg }]}>
      <Text style={[S.pillText, { color: fg }]}>{text}</Text>
    </View>
  );
}

export function Card({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  const S=useStyles();
  return (
    <View style={S.card}>
      {title ? <Text style={S.h2}>{title}</Text> : null}
      {children}
    </View>
  );
}
