/** Browser/Edge-safe names only. Secret and server runtime modules must not be imported here. */
export const LINGHAO_PASSPORT_V4_FAMILY_COOKIE =
  "__Host-aistory_linghao_passport_v4_family_v1" as const;
export const LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE =
  "__Host-aistory_linghao_passport_v4_tx_v1" as const;
export const LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE =
  "__Host-aistory_linghao_passport_v4_user_v1" as const;
export const LINGHAO_PASSPORT_V4_LOGOUT_COOKIE =
  "__Host-aistory_linghao_passport_v4_logout_v1" as const;

export const LINGHAO_PASSPORT_V4_PRODUCTION_COOKIE_NAMES = Object.freeze([
  LINGHAO_PASSPORT_V4_FAMILY_COOKIE,
  LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE,
  LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE,
  LINGHAO_PASSPORT_V4_LOGOUT_COOKIE,
] as const);

export function hasLinghaoPassportV4ProductCookieHeader(
  cookieHeader: string | null | undefined,
): boolean {
  return (cookieHeader ?? "")
    .split(";")
    .some((item) =>
      item.trim().startsWith(`${LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE}=`),
    );
}
