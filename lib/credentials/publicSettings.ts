export function coercePublicPrefetchDepth(value: unknown): 0 | 1 {
  return Number(value) === 0 ? 0 : 1;
}
