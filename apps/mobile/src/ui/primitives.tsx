/**
 * Mobile primitives, built on the shared token palette.
 *
 * Every component resolves colours through `useTheme()` at render, so light and
 * dark both work without a single hardcoded hex at a call site. Touch targets
 * never drop below TOUCH_TARGET.
 */

import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { font, radius, space, TOUCH_TARGET, useTheme, type Palette } from "../theme";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

function toneColors(t: Palette, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case "success":
      return { bg: t.successSubtle, fg: t.success };
    case "warning":
      return { bg: t.warningSubtle, fg: t.warning };
    case "danger":
      return { bg: t.dangerSubtle, fg: t.danger };
    case "info":
      return { bg: t.infoSubtle, fg: t.info };
    default:
      return { bg: t.neutralSubtle, fg: t.textMuted };
  }
}

// --- Layout -----------------------------------------------------------------

export function Screen({
  children,
  scroll = true,
  padded = true,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
}) {
  const t = useTheme();
  const style: ViewStyle = {
    flex: 1,
    backgroundColor: t.canvas,
    ...(padded ? { paddingHorizontal: space.lg } : null),
  };
  if (!scroll) return <View style={style}>{children}</View>;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.canvas }}
      contentContainerStyle={{
        ...(padded ? { paddingHorizontal: space.lg } : null),
        paddingTop: space.lg,
        // Clears the tab bar so the last row is never trapped under it.
        paddingBottom: space.xxl * 2,
      }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <Text style={[{ fontSize: font.xxl, fontWeight: "700", color: t.text, letterSpacing: -0.4 }, style]}>
      {children}
    </Text>
  );
}

export function Heading({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <Text style={[{ fontSize: font.lg, fontWeight: "600", color: t.text }, style]}>{children}</Text>
  );
}

export function Body({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[{ fontSize: font.base, color: t.text }, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[{ fontSize: font.sm, color: t.textMuted }, style]}>{children}</Text>;
}

export function Subtle({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[{ fontSize: font.xs, color: t.textSubtle }, style]}>{children}</Text>;
}

/** Section label above a group of cards. */
export function SectionLabel({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text
      style={{
        fontSize: font.xs,
        fontWeight: "700",
        color: t.textSubtle,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        marginBottom: space.sm,
        marginTop: space.lg,
      }}
    >
      {children}
    </Text>
  );
}

export function Card({
  title,
  right,
  children,
  style,
}: {
  title?: string;
  right?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: t.surface,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.border,
          padding: space.lg,
          marginBottom: space.md,
        },
        style,
      ]}
    >
      {(title || right) && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: children ? space.md : 0,
          }}
        >
          {title ? <Heading>{title}</Heading> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Row({
  children,
  gap = space.sm,
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap }, style]}>{children}</View>;
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginVertical: space.md }} />;
}

// --- Controls ---------------------------------------------------------------

export function Button({
  title,
  onPress,
  variant = "primary",
  tone,
  loading = false,
  disabled = false,
  icon,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  /** Overrides the primary fill, for destructive or state-coloured actions. */
  tone?: Tone;
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const accent = tone ? toneColors(t, tone).fg : t.primary;
  const isDisabled = disabled || loading;

  const base: ViewStyle = {
    minHeight: TOUCH_TARGET,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    opacity: isDisabled ? 0.5 : 1,
  };
  const fill: ViewStyle =
    variant === "primary"
      ? { backgroundColor: accent }
      : variant === "secondary"
        ? { backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }
        : { backgroundColor: "transparent" };
  const fg = variant === "primary" ? (tone ? "#ffffff" : t.primaryFg) : accent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={isDisabled ? undefined : onPress}
      style={({ pressed }) => [base, fill, pressed && !isDisabled ? { opacity: 0.75 } : null, style]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : icon ? (
        <Ionicons name={icon} size={18} color={fg} />
      ) : null}
      <Text style={{ color: fg, fontWeight: "600", fontSize: font.base }}>{title}</Text>
    </Pressable>
  );
}

export function Input({
  label,
  error,
  hint,
  style,
  ...rest
}: TextInputProps & { label?: string; error?: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: space.md }}>
      {label ? (
        <Text style={{ fontSize: font.sm, fontWeight: "600", color: t.textMuted, marginBottom: space.xs }}>
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={t.textSubtle}
        style={[
          {
            minHeight: TOUCH_TARGET,
            backgroundColor: t.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: error ? t.danger : t.border,
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            fontSize: font.base,
            color: t.text,
          },
          style,
        ]}
        {...rest}
      />
      {error ? (
        <Text style={{ fontSize: font.xs, color: t.danger, marginTop: space.xs }}>{error}</Text>
      ) : hint ? (
        <Text style={{ fontSize: font.xs, color: t.textSubtle, marginTop: space.xs }}>{hint}</Text>
      ) : null}
    </View>
  );
}

// --- Status -----------------------------------------------------------------

export function Badge({ text, tone = "neutral" }: { text: string; tone?: Tone }) {
  const t = useTheme();
  const { bg, fg } = toneColors(t, tone);
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 3, alignSelf: "flex-start" }}>
      <Text style={{ color: fg, fontSize: font.xs, fontWeight: "700" }}>{text}</Text>
    </View>
  );
}

/** Badge with a leading dot — the standard row-status treatment. */
export function StatusDot({ text, tone = "neutral" }: { text: string; tone?: Tone }) {
  const t = useTheme();
  const { bg, fg } = toneColors(t, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: bg,
        borderRadius: radius.sm,
        paddingHorizontal: space.sm,
        paddingVertical: 3,
        alignSelf: "flex-start",
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: fg }} />
      <Text style={{ color: fg, fontSize: font.xs, fontWeight: "700" }}>{text}</Text>
    </View>
  );
}

export function Banner({
  tone = "info",
  title,
  message,
  icon,
}: {
  tone?: Tone;
  title: string;
  message?: string;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const t = useTheme();
  const { bg, fg } = toneColors(t, tone);
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        gap: space.sm,
        backgroundColor: bg,
        borderRadius: radius.md,
        padding: space.md,
        marginBottom: space.md,
      }}
    >
      {icon ? <Ionicons name={icon} size={18} color={fg} style={{ marginTop: 1 }} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: font.sm, fontWeight: "700" }}>{title}</Text>
        {message ? (
          <Text style={{ color: t.textMuted, fontSize: font.sm, marginTop: 2 }}>{message}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function EmptyState({
  title,
  message,
  icon = "file-tray-outline",
  action,
}: {
  title: string;
  message?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  action?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={{ alignItems: "center", paddingVertical: space.xxl, gap: space.sm }}>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: t.neutralSubtle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={20} color={t.textSubtle} />
      </View>
      <Text style={{ fontSize: font.base, fontWeight: "600", color: t.text }}>{title}</Text>
      {message ? (
        <Text style={{ fontSize: font.sm, color: t.textMuted, textAlign: "center", maxWidth: 280 }}>
          {message}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: "center", paddingVertical: space.xxl, gap: space.sm }}>
      <ActivityIndicator color={t.primary} />
      <Text style={{ fontSize: font.sm, color: t.textMuted }}>{label}</Text>
    </View>
  );
}

/** Tappable list row with a chevron — the standard navigation affordance. */
export function ListRow({
  title,
  subtitle,
  right,
  icon,
  onPress,
  last = false,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  last?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: TOUCH_TARGET + 6,
        paddingVertical: space.sm,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: t.border,
        backgroundColor: pressed && onPress ? t.surfaceSunken : "transparent",
      })}
    >
      {icon ? <Ionicons name={icon} size={20} color={t.textSubtle} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: font.base, color: t.text, fontWeight: "500" }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ fontSize: font.sm, color: t.textMuted, marginTop: 1 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {onPress ? <Ionicons name="chevron-forward" size={16} color={t.textSubtle} /> : null}
    </Pressable>
  );
}

/** Single metric, used in the home screen's summary grid. */
export function StatTile({
  label,
  value,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string | number;
  tone?: Tone;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const t = useTheme();
  const { fg } = toneColors(t, tone);
  return (
    <View
      style={{
        flex: 1,
        minWidth: 140,
        backgroundColor: t.surface,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.border,
        padding: space.md,
      }}
    >
      <Row gap={space.xs}>
        {icon ? <Ionicons name={icon} size={13} color={t.textSubtle} /> : null}
        <Text style={{ fontSize: font.xs, color: t.textMuted, fontWeight: "600" }}>{label}</Text>
      </Row>
      <Text
        style={{
          fontSize: font.xxl,
          fontWeight: "700",
          color: tone === "neutral" ? t.text : fg,
          marginTop: space.xs,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
    </View>
  );
}
