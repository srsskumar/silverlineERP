/** Capture a photo, render the employee/GPS/time overlay, and burn it into a JPEG under 200 KB. */

import { createElement, forwardRef, useRef, useState } from "react";
import type { RefObject } from "react";

// ---------------------------------------------------------------------------
// Lazy native-module loader.
// ---------------------------------------------------------------------------
// expo-camera / react-native / react-native-view-shot CANNOT be imported at
// module top level: their native bindings don't exist under node, and
// test/camera.test.ts imports this file's PURE helpers via `tsx --test`.
// Every native access below goes through loadNativeModule() at call/render
// time, so importing this module in node is side-effect free. The ids are
// static literals (except the optional expo-file-system, see
// stabilizeInCacheDir) so Metro still bundles the installed packages.

declare const require: ((id: string) => unknown) | undefined;

function loadNativeModule<T>(id: string): T | null {
  try {
    if (typeof require === "undefined" || require === null) return null;
    switch(id){
      case 'expo-camera':return require('expo-camera') as T;
      case 'react-native':return require('react-native') as T;
      case 'react-native-view-shot':return require('react-native-view-shot') as T;
      case 'expo-file-system':return require('expo-file-system') as T;
      default:return null;
    }
  } catch {
    return null;
  }
}

type ExpoCameraModule = typeof import("expo-camera");
type RNModule = typeof import("react-native");
type ViewShotModule = typeof import("react-native-view-shot");

function expoCameraModuleOrThrow(): ExpoCameraModule {
  const mod = loadNativeModule<ExpoCameraModule>("expo-camera");
  if (!mod) {
    throw new Error(
      "expo-camera is unavailable in this runtime — camera capture must run on-device (Expo Go / dev build).",
    );
  }
  return mod;
}

function rnModuleOrThrow(): RNModule {
  const mod = loadNativeModule<RNModule>("react-native");
  if (!mod) {
    throw new Error(
      "react-native runtime is unavailable — <EvidenceWatermarkView/> must render on-device.",
    );
  }
  return mod;
}

// ---------------------------------------------------------------------------
// Backward-compatible pass-throughs (no in-repo callers, but the names stay).
// ---------------------------------------------------------------------------
// Previously `export { CameraView, useCameraPermissions } from "expo-camera"`.
// A static re-export would load native code at import time and break node:test
// for the pure helpers, so both names are now thin lazy wrappers with the same
// call/render contract: CameraView forwards its ref to the real view (so
// takePictureAsync via ref keeps working) and useCameraPermissions delegates
// to the real hook.

type CameraViewComponent = ExpoCameraModule["CameraView"];
type UseCameraPermissionsHook = ExpoCameraModule["useCameraPermissions"];

export const CameraView: CameraViewComponent = forwardRef(
  function CameraView(
    props: import("expo-camera").CameraViewProps,
    ref: React.Ref<import("expo-camera").CameraView>,
  ) {
    const Real = expoCameraModuleOrThrow().CameraView;
    return createElement(Real as never, { ...(props as object), ref } as never);
  },
) as unknown as CameraViewComponent;

export const useCameraPermissions: UseCameraPermissionsHook =
  ((...args: Parameters<UseCameraPermissionsHook>) => {
    return expoCameraModuleOrThrow().useCameraPermissions(...args);
  }) as UseCameraPermissionsHook;

// ---------------------------------------------------------------------------
// Watermark model + text builders (PURE — covered by test/camera.test.ts).
// ---------------------------------------------------------------------------

export interface Watermark {
  name: string;
  empNo: string;
  latitude: number | null;
  longitude: number | null;
  /** GPS accuracy in meters (null/omitted when the OS reports none). */
  accuracy?: number | null;
  /** ISO instant or pre-formatted display string; ISO renders as IST. */
  timestamp: string;
  /** Project / site label (PRD 9.2 "project/site"). */
  projectSite?: string;
  /** Village label (PRD 9.2 "village"). */
  village?: string;
}

/**
 * Format an ISO-8601 instant in Asia/Kolkata and tag it IST.
 * Only strict ISO-like inputs are parsed (V8's Date parser accepts stray
 * display strings like "duty log 08-Sep" as year-2001 dates, so anything else
 * passes through verbatim — legacy sidecar compat).
 */
const ISO_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function formatTimestampIST(input: string): string {
  if (!ISO_LIKE.test(input.trim())) return input;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
    return `${parts} IST`;
  } catch {
    return input;
  }
}

/**
 * The white <Text> lines burned into the bottom strip, in order: employee,
 * GPS (+ accuracy), timestamp IST, project/site + village (omitted when both
 * are absent).
 */
export function buildWatermarkLines(w: Watermark): string[] {
  const hasGps =
    typeof w.latitude === "number" &&
    typeof w.longitude === "number" &&
    Number.isFinite(w.latitude) &&
    Number.isFinite(w.longitude);
  const gps = hasGps
    ? `${(w.latitude as number).toFixed(6)}, ${(w.longitude as number).toFixed(6)}` +
      (w.accuracy !== null && w.accuracy !== undefined
        ? ` ±${Math.round(w.accuracy)}m`
        : "")
    : "no-gps";
  const lines = [
    `${w.name} · ${w.empNo}`,
    gps,
    formatTimestampIST(w.timestamp),
  ];
  const site = [w.projectSite, w.village]
    .filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    )
    .join(" · ");
  if (site) lines.push(site);
  return lines;
}

/**
 * Single-line sidecar text (audit payload + legacy overlay string).
 * For legacy inputs (no accuracy/site, display timestamp) the output is
 * byte-identical to the pre-burn-in format:
 * `{name} · {empNo} · {gps} · {timestamp}`.
 */
export function renderWatermarkText(w: Watermark): string {
  return buildWatermarkLines(w).join(" · ");
}

// ---------------------------------------------------------------------------
// Budget + quality ladder (PURE — covered by test/camera.test.ts).
// ---------------------------------------------------------------------------

/** First-attempt JPEG quality for both the raw frame and the burn-in shot. */
export const EVIDENCE_PHOTO_QUALITY = 0.6 as const;

/** Burn-in re-capture ladder: 0.6 → 0.5 → 0.4 (3 attempts, then throw). */
export const BURN_QUALITY_LADDER = [0.6, 0.5, 0.4] as const;

/** PRD ≤200KB evidence budget, in bytes. */
export const MAX_EVIDENCE_BYTES = 200 * 1024;

/** Max view-shot re-captures before WatermarkTooLargeError. */
export const MAX_BURN_ATTEMPTS = BURN_QUALITY_LADDER.length;

/** JPEG quality for burn attempt n (0-based); null when the ladder is spent. */
export function qualityForBurnAttempt(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return BURN_QUALITY_LADDER[0];
  return attempt < BURN_QUALITY_LADDER.length
    ? BURN_QUALITY_LADDER[attempt]
    : null;
}

/** True when a burned file fits the evidence budget. */
export function isWithinEvidenceBudget(
  bytes: number,
  maxBytes: number = MAX_EVIDENCE_BYTES,
): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= maxBytes;
}

/** Stable cache/upload name derived from content hash. */
export function stableEvidenceFileName(sha256: string): string {
  const stem =
    (sha256 || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 12) ||
    "unknown";
  return `evidence-${stem}.jpg`;
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS-180-4), also usable by the Node unit tests.
// ---------------------------------------------------------------------------

const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 over raw bytes → lowercase hex. */
export function sha256Hex(data: Uint8Array): string {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const byteLen = data.length;
  const bitLenHi = Math.floor((byteLen * 8) / 4294967296);
  const bitLenLo = (byteLen << 3) >>> 0;
  const totalLen = (Math.floor((byteLen + 8) / 64) + 1) * 64;

  const msg = new Uint8Array(totalLen);
  msg.set(data);
  msg[byteLen] = 0x80;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  view.setUint32(totalLen - 8, bitLenHi);
  view.setUint32(totalLen - 4, bitLenLo);

  const w = new Uint32Array(64);
  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 =
        rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** SHA-256 of a UTF-8 string → lowercase hex (convenience over sha256Hex). */
export function sha256HexOfText(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// Typed oversize error (retryable by the sync-queue convention).
// ---------------------------------------------------------------------------

export class WatermarkTooLargeError extends Error {
  readonly code = "EVIDENCE_TOO_LARGE" as const;
  /** Mirrors ApiError.retryable: the sync queue treats this as BACKOFF. */
  readonly retryable = true as const;

  constructor(
    readonly bytes: number,
    readonly maxBytes: number = MAX_EVIDENCE_BYTES,
    readonly attempts: number = MAX_BURN_ATTEMPTS,
  ) {
    super(
      `Burned evidence is ${bytes}B (budget ${maxBytes}B) after ${attempts} quality attempts — retry capture later`,
    );
    this.name = "WatermarkTooLargeError";
  }
}

/**
 * Retryable-capture check for callers: true for WatermarkTooLargeError or any
 * error carrying `retryable: true` (ApiError-compatible). src/sync/queue.ts
 * additionally treats EVERY thrown executor error as BACKOFF, so this error
 * is retryable end-to-end by construction.
 */
export function isRetryableCaptureError(e: unknown): boolean {
  if (e instanceof WatermarkTooLargeError) return true;
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { retryable?: unknown }).retryable === true
  );
}

// ---------------------------------------------------------------------------
// Burn-in view + device pipeline (on-device only; never runs under node:test).
// ---------------------------------------------------------------------------

export interface EvidenceWatermarkViewProps {
  photoUri: string;
  photoWidth: number;
  photoHeight: number;
  watermark: Watermark;
  /**
   * Ref attached to the root view — pass the SAME object to burnStaged()
   * (the hook owns one: `watermarkViewRef`).
   */
  viewRef: RefObject<import("react-native").View | null>;
  /**
   * Layout width in dp (defaults to the window width). Height derives from
   * the captured photo's aspect ratio so the screenshot has no distortion.
   */
  layoutWidth?: number;
  /** Fired once layout + photo decode are both done: safe moment to burn. */
  onReady?: () => void;
}

/**
 * Full-bleed photo with the watermark strip composited on top. burnStaged()
 * screenshots THIS view, so the strip ends up burned into the JPEG pixels.
 */
export function EvidenceWatermarkView(props: EvidenceWatermarkViewProps) {
  const rn = rnModuleOrThrow();
  const laidOut = useRef(false);
  const loaded = useRef(false);
  const notified = useRef(false);
  const maybeReady = () => {
    if (laidOut.current && loaded.current && !notified.current) {
      notified.current = true;
      props.onReady?.();
    }
  };

  const width = props.layoutWidth ?? rn.Dimensions.get("window").width;
  const height =
    props.photoWidth > 0
      ? (width * props.photoHeight) / props.photoWidth
      : (width * 4) / 3;
  const lines = buildWatermarkLines(props.watermark);

  return createElement(
    rn.View,
    {
      ref: props.viewRef,
      collapsable: false,
      onLayout: () => {
        laidOut.current = true;
        maybeReady();
      },
      style: {
        width,
        height,
        backgroundColor: "#000",
        overflow: "hidden",
      },
    },
    createElement(rn.Image, {
      source: { uri: props.photoUri },
      resizeMode: "cover",
      onLoad: () => {
        loaded.current = true;
        maybeReady();
      },
      style: { position: "absolute", left: 0, top: 0, width, height },
    }),
    createElement(
      rn.View,
      {
        style: {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.65)",
          paddingHorizontal: 10,
          paddingVertical: 8,
        },
      },
      ...lines.map((line, i) =>
        createElement(
          rn.Text,
          {
            key: `wm-${i}`,
            style: { color: "#fff", fontSize: 12, lineHeight: 16 },
          },
          line,
        ),
      ),
    ),
  );
}

/** Raw staged frame from capture(), awaiting its burn-in screenshot. */
export interface StagedPhoto {
  uri: string;
  width: number;
  height: number;
  watermark: Watermark;
  watermarkText: string;
}

export interface CapturedEvidence {
  uri: string;
  watermark: Watermark;
  watermarkText: string;
  /** Raw frame dimensions (present since burn-in support was added). */
  width?: number;
  height?: number;
}

/** Burned file: pixels + audit sidecar. */
export interface BurnedEvidence {
  uri: string;
  width: number;
  height: number;
  sha256: string;
  bytes: number;
  /** Stable name (`evidence-<sha12>.jpg`) for the upload payload. */
  fileName: string;
  watermark: Watermark;
  watermarkText: string;
}

async function readUriBytes(uri:string):Promise<Uint8Array>{
  const fs=loadNativeModule<typeof import('expo-file-system')>('expo-file-system');
  if(!fs)throw new Error('File system is unavailable');
  return new fs.File(uri).bytes();
}
function removeCapture(uri:string){try{const fs=loadNativeModule<typeof import('expo-file-system')>('expo-file-system');if(fs){const file=new fs.File(uri);if(file.exists)file.delete();}}catch{/* Cache cleanup can retry on the next launch. */}}

/** JPEG dimensions via RN (falls back to the staged frame dims on failure). */
function probeImageSize(uri: string): Promise<{ width: number; height: number }> {
  const rn = rnModuleOrThrow();
  return new Promise((resolve, reject) => {
    rn.Image.getSize(
      uri,
      (w: number, h: number) => resolve({ width: w, height: h }),
      (err: unknown) =>
        reject(err instanceof Error ? err : new Error("getSize failed")),
    );
  });
}

export function useEvidenceCamera() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<import("expo-camera").CameraView | null>(null);
  const watermarkViewRef =
    useRef<import("react-native").View | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<StagedPhoto | null>(null);
  const pendingRef = useRef<StagedPhoto | null>(null);

  const stage = (s: StagedPhoto | null) => {
    pendingRef.current = s;
    setPendingPhoto(s);
  };

  /**
   * Shutter step (backward compatible): captures the raw frame at 0.6 quality
   * and stages it for burn-in. Returns the legacy { uri, watermark,
   * watermarkText } shape (plus raw width/height). The caller then mounts
   * <EvidenceWatermarkView viewRef={watermarkViewRef} photoUri={uri} …/>
   * and calls burnStaged().
   */
  const capture = async (watermark: Watermark): Promise<CapturedEvidence> => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) throw new Error("Camera permission denied");
    }
    const camera = cameraRef.current;
    if (!camera) throw new Error("Camera not ready");
    const photo: import("expo-camera").CameraCapturedPicture =
      await camera.takePictureAsync({
        quality: EVIDENCE_PHOTO_QUALITY,
        base64: false,
        exif: false,
      });
    if (!photo?.uri) throw new Error("Capture failed");
    const watermarkText = renderWatermarkText(watermark);
    stage({
      uri: photo.uri,
      width: photo.width,
      height: photo.height,
      watermark,
      watermarkText,
    });
    return {
      uri: photo.uri,
      width: photo.width,
      height: photo.height,
      watermark,
      watermarkText,
    };
  };

  /**
   * Burn step: screenshots the MOUNTED <EvidenceWatermarkView/> (must be laid
   * out in a foreground component — see module header) at ladder qualities
   * until the JPEG fits ≤200KB. Returns pixels + sidecar; clears the staged
   * photo. Throws WatermarkTooLargeError (retryable) when 3 attempts exceed
   * the budget; the staged photo is KEPT in that case so the caller can retry
   * or discardStaged().
   */
  const burnStaged = async (opts?: {
    viewRef?: RefObject<import("react-native").View | null>;
  }): Promise<BurnedEvidence> => {
    const staged = pendingRef.current;
    if (!staged) {
      throw new Error(
        "No staged photo — call capture() first, mount <EvidenceWatermarkView/>, then burn.",
      );
    }
    const vs = loadNativeModule<ViewShotModule>("react-native-view-shot");
    if (!vs) {
      throw new Error(
        "react-native-view-shot is unavailable in this runtime — burn-in must run on-device.",
      );
    }
    const target = opts?.viewRef ?? watermarkViewRef;
    let lastBytes = 0;
    for (let attempt = 0; attempt < MAX_BURN_ATTEMPTS; attempt += 1) {
      const quality = qualityForBurnAttempt(attempt);
      if (quality === null) break;
      const tmpUri: string = await vs.captureRef(target, {
        format: "jpg",
        quality,
        result: "tmpfile",
      });
      const bytes = await readUriBytes(tmpUri);
      lastBytes = bytes.length;
      if (!isWithinEvidenceBudget(bytes.length)) {removeCapture(tmpUri);continue;}
      const dims = await probeImageSize(tmpUri).catch(() => ({
        width: staged.width,
        height: staged.height,
      }));
      const sha256 = sha256Hex(bytes);
      const fileName = stableEvidenceFileName(sha256);
      const uri = tmpUri;
      removeCapture(staged.uri);
      stage(null);
      return {
        uri,
        width: dims.width,
        height: dims.height,
        sha256,
        bytes: bytes.length,
        fileName,
        watermark: staged.watermark,
        watermarkText: staged.watermarkText,
      };
    }
    throw new WatermarkTooLargeError(lastBytes);
  };

  const discardStaged = () => {
    if(pendingRef.current)removeCapture(pendingRef.current.uri);
    stage(null);
  };

  return {
    cameraRef,
    permission,
    requestPermission,
    capture,
    pendingPhoto,
    watermarkViewRef,
    burnStaged,
    discardStaged,
  };
}
