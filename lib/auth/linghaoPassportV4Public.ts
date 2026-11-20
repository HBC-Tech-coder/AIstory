/**
 * Browser-safe public constants for the isolated Linghao Passport v4 local
 * test surface. Keep filesystem paths, selector names, and secret handling out
 * of this module because the hidden client component imports it.
 */

export const LINGHAO_PASSPORT_V4_ISSUER = "http://127.0.0.1:8000";
export const LINGHAO_PASSPORT_V4_CLIENT_ID =
  "aistory-local-passport-v4-web";
export const LINGHAO_PASSPORT_V4_REDIRECT_URI =
  "http://127.0.0.1:4200/api/auth/linghao-passport-v4/callback";
export const LINGHAO_PASSPORT_V4_RETURN_PATH =
  "/auth/linghao-passport-v4";
export const LINGHAO_PASSPORT_V4_DISPLAY_NAME =
  "灵号通行证 v4 本地测试用户";

