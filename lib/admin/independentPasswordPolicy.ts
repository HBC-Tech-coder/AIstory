export const INDEPENDENT_ADMIN_PASSWORD_POLICY = Object.freeze({
  minimumCodePoints: 9,
  maximumUtf8Bytes: 512,
  minimumCategories: 3,
} as const);

export type IndependentAdminPasswordPolicyViolation =
  | "not_a_string"
  | "public_default_password"
  | "too_short"
  | "too_large"
  | "insufficient_categories";

const PUBLIC_DEFAULT_PASSWORD = "admin888";

export function independentAdminPasswordPolicyViolation(
  password: unknown,
): IndependentAdminPasswordPolicyViolation | null {
  if (typeof password !== "string") return "not_a_string";
  if (password === PUBLIC_DEFAULT_PASSWORD) return "public_default_password";
  if ([...password].length < INDEPENDENT_ADMIN_PASSWORD_POLICY.minimumCodePoints) return "too_short";
  if (new TextEncoder().encode(password).byteLength > INDEPENDENT_ADMIN_PASSWORD_POLICY.maximumUtf8Bytes) return "too_large";
  const categories = [
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  return categories >= INDEPENDENT_ADMIN_PASSWORD_POLICY.minimumCategories
    ? null
    : "insufficient_categories";
}

export function isIndependentAdminPasswordAllowed(password: unknown): password is string {
  return independentAdminPasswordPolicyViolation(password) === null;
}
