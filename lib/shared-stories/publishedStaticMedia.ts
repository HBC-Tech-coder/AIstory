/**
 * Frozen catalog of the public, already-published static first-scene presets.
 *
 * These 122 paths are the exact contents of the verified deployment manifest
 * (reference/public-image-catalog.json). They are embedded here, not imported
 * from the reference JSON, so this module stays browser-safe: it has no
 * filesystem, environment, or Node.js imports and can be imported directly by
 * the frontend.
 *
 * Matching is exact string membership only. There is deliberately no prefix
 * matching, glob, regex, case folding, or extension guessing: a URL is allowed
 * only if it is one of the names below. This catalog covers public preset media
 * only — it never authorizes authored/restricted scene auto-exports.
 */

const PUBLISHED_STATIC_MEDIA = [
  "/home/firstscene/f0.webp",
  "/home/firstscene/f1.webp",
  "/home/firstscene/f10.webp",
  "/home/firstscene/f11.webp",
  "/home/firstscene/f12.webp",
  "/home/firstscene/f13.webp",
  "/home/firstscene/f14.webp",
  "/home/firstscene/f15.webp",
  "/home/firstscene/f16.webp",
  "/home/firstscene/f17.webp",
  "/home/firstscene/f18.webp",
  "/home/firstscene/f19.webp",
  "/home/firstscene/f2.webp",
  "/home/firstscene/f20.webp",
  "/home/firstscene/f21.webp",
  "/home/firstscene/f22.webp",
  "/home/firstscene/f23.webp",
  "/home/firstscene/f24.webp",
  "/home/firstscene/f25.webp",
  "/home/firstscene/f26.webp",
  "/home/firstscene/f27.webp",
  "/home/firstscene/f28.webp",
  "/home/firstscene/f29.webp",
  "/home/firstscene/f3.webp",
  "/home/firstscene/f4.webp",
  "/home/firstscene/f5.webp",
  "/home/firstscene/f6.webp",
  "/home/firstscene/f7.webp",
  "/home/firstscene/f8.webp",
  "/home/firstscene/f9.webp",
  "/home/firstscene/m0.webp",
  "/home/firstscene/m1.webp",
  "/home/firstscene/m10.webp",
  "/home/firstscene/m11.webp",
  "/home/firstscene/m12.webp",
  "/home/firstscene/m13.webp",
  "/home/firstscene/m14.webp",
  "/home/firstscene/m15.webp",
  "/home/firstscene/m16.webp",
  "/home/firstscene/m17.webp",
  "/home/firstscene/m18.webp",
  "/home/firstscene/m19.webp",
  "/home/firstscene/m2.webp",
  "/home/firstscene/m20.webp",
  "/home/firstscene/m21.webp",
  "/home/firstscene/m22.webp",
  "/home/firstscene/m23.webp",
  "/home/firstscene/m24.webp",
  "/home/firstscene/m25.webp",
  "/home/firstscene/m26.webp",
  "/home/firstscene/m27.webp",
  "/home/firstscene/m28.webp",
  "/home/firstscene/m29.webp",
  "/home/firstscene/m3.webp",
  "/home/firstscene/m30.webp",
  "/home/firstscene/m31.webp",
  "/home/firstscene/m4.webp",
  "/home/firstscene/m5.webp",
  "/home/firstscene/m6.webp",
  "/home/firstscene/m7.webp",
  "/home/firstscene/m8.webp",
  "/home/firstscene/m9.webp",
  "/home/firstscene-portrait/f0.webp",
  "/home/firstscene-portrait/f1.webp",
  "/home/firstscene-portrait/f10.webp",
  "/home/firstscene-portrait/f11.webp",
  "/home/firstscene-portrait/f12.webp",
  "/home/firstscene-portrait/f13.webp",
  "/home/firstscene-portrait/f14.webp",
  "/home/firstscene-portrait/f15.webp",
  "/home/firstscene-portrait/f16.webp",
  "/home/firstscene-portrait/f17.webp",
  "/home/firstscene-portrait/f18.webp",
  "/home/firstscene-portrait/f19.webp",
  "/home/firstscene-portrait/f2.webp",
  "/home/firstscene-portrait/f20.webp",
  "/home/firstscene-portrait/f21.webp",
  "/home/firstscene-portrait/f22.webp",
  "/home/firstscene-portrait/f23.webp",
  "/home/firstscene-portrait/f24.webp",
  "/home/firstscene-portrait/f25.webp",
  "/home/firstscene-portrait/f26.webp",
  "/home/firstscene-portrait/f27.webp",
  "/home/firstscene-portrait/f28.webp",
  "/home/firstscene-portrait/f29.webp",
  "/home/firstscene-portrait/f3.webp",
  "/home/firstscene-portrait/f4.webp",
  "/home/firstscene-portrait/f5.webp",
  "/home/firstscene-portrait/f6.webp",
  "/home/firstscene-portrait/f7.webp",
  "/home/firstscene-portrait/f8.webp",
  "/home/firstscene-portrait/f9.webp",
  "/home/firstscene-portrait/m0.webp",
  "/home/firstscene-portrait/m1.webp",
  "/home/firstscene-portrait/m10.webp",
  "/home/firstscene-portrait/m11.webp",
  "/home/firstscene-portrait/m12.webp",
  "/home/firstscene-portrait/m13.webp",
  "/home/firstscene-portrait/m14.webp",
  "/home/firstscene-portrait/m15.webp",
  "/home/firstscene-portrait/m16.webp",
  "/home/firstscene-portrait/m17.webp",
  "/home/firstscene-portrait/m18.webp",
  "/home/firstscene-portrait/m19.webp",
  "/home/firstscene-portrait/m2.webp",
  "/home/firstscene-portrait/m20.webp",
  "/home/firstscene-portrait/m21.webp",
  "/home/firstscene-portrait/m22.webp",
  "/home/firstscene-portrait/m23.webp",
  "/home/firstscene-portrait/m24.webp",
  "/home/firstscene-portrait/m25.webp",
  "/home/firstscene-portrait/m26.webp",
  "/home/firstscene-portrait/m27.webp",
  "/home/firstscene-portrait/m28.webp",
  "/home/firstscene-portrait/m29.webp",
  "/home/firstscene-portrait/m3.webp",
  "/home/firstscene-portrait/m4.webp",
  "/home/firstscene-portrait/m5.webp",
  "/home/firstscene-portrait/m6.webp",
  "/home/firstscene-portrait/m7.webp",
  "/home/firstscene-portrait/m8.webp",
  "/home/firstscene-portrait/m9.webp",
] as const;

/** Exact published static scene media URLs, in verified manifest order. */
export const PUBLISHED_STATIC_MEDIA_PATHS: readonly string[] = Object.freeze([
  ...PUBLISHED_STATIC_MEDIA,
]);

const PUBLISHED_STATIC_MEDIA_SET: ReadonlySet<string> = new Set(PUBLISHED_STATIC_MEDIA_PATHS);

/**
 * Exact-match predicate for the published static catalog. Safe in browser code:
 * no Node.js APIs are used. Unknown, malformed, encoded, or look-alike values
 * (for example `/home/firstscene/f30.webp`) return false.
 */
export function isPublishedStaticMediaUrl(value: unknown): boolean {
  return typeof value === "string" && PUBLISHED_STATIC_MEDIA_SET.has(value);
}
