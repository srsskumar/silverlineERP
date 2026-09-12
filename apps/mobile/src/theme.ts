/**
 * Mobile design tokens.
 *
 * Mirrors the web token roles (canvas/surface/text/primary/state) so the two
 * clients read as one product, retuned for a phone: larger touch targets, a
 * slightly larger base size than the web's dense 13px, and colour still
 * reserved almost entirely for state.
 *
 * Values are plain hex rather than HSL triples because React Native has no
 * CSS custom properties — `useTheme()` returns the resolved palette instead.
 */

import { useColorScheme } from "react-native";

export interface Palette {
  canvas: string;
  surface: string;
  surfaceSunken: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  textInverse: string;
  primary: string;
  primaryHover: string;
  primarySubtle: string;
  primaryFg: string;
  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  danger: string;
  dangerSubtle: string;
  info: string;
  infoSubtle: string;
  neutralSubtle: string;
  /** Scrim behind modals and sheets. */
  scrim: string;
}

export const light: Palette = {
  canvas: "#f5f7fa",
  surface: "#ffffff",
  surfaceSunken: "#f8fafc",
  surfaceRaised: "#ffffff",
  border: "#e2e6ec",
  borderStrong: "#c8cfd9",
  text: "#171b24",
  textMuted: "#5f6875",
  textSubtle: "#8b93a1",
  textInverse: "#ffffff",
  primary: "#2f5bff",
  primaryHover: "#2247d6",
  primarySubtle: "#eaf0ff",
  primaryFg: "#ffffff",
  success: "#1f8757",
  successSubtle: "#e8f7ef",
  warning: "#b06a08",
  warningSubtle: "#fdf1de",
  danger: "#d32836",
  dangerSubtle: "#fdecee",
  info: "#1477c4",
  infoSubtle: "#e8f4fd",
  neutralSubtle: "#eef1f5",
  scrim: "rgba(0,0,0,0.45)",
};

export const dark: Palette = {
  canvas: "#0f1219",
  surface: "#161a23",
  surfaceSunken: "#11151d",
  surfaceRaised: "#1d222d",
  border: "#2e3440",
  borderStrong: "#454d5c",
  text: "#f1f4f8",
  textMuted: "#a4adbb",
  textSubtle: "#78818f",
  textInverse: "#0f1219",
  primary: "#5b83ff",
  primaryHover: "#7a9bff",
  primarySubtle: "#1c2647",
  primaryFg: "#0b1020",
  success: "#3ec07f",
  successSubtle: "#12301f",
  warning: "#e0a13f",
  warningSubtle: "#332612",
  danger: "#f0656f",
  dangerSubtle: "#3a1a1d",
  info: "#4aa8e8",
  infoSubtle: "#12283a",
  neutralSubtle: "#222833",
  scrim: "rgba(0,0,0,0.6)",
};

/** Spacing scale in points; 4pt base so rhythm stays predictable. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

export const font = {
  // Phone base is 15 (web is 13): the same information, a longer arm's length.
  xs: 11,
  sm: 13,
  base: 15,
  lg: 17,
  xl: 20,
  xxl: 26,
} as const;

/**
 * Minimum touch target. 44pt is the Apple HIG floor and close to Android's
 * 48dp; field users wear gloves, so controls never go below it.
 */
export const TOUCH_TARGET = 44;

export function useTheme(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

export function useIsDark(): boolean {
  return useColorScheme() === "dark";
}
