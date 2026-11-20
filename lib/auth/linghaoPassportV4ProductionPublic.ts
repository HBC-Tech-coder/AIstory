/**
 * Browser-safe public tuple for the new Linghao Passport v4 production client.
 *
 * Keep selectors, filesystem paths, host receipts and credential references
 * out of this module. The tuple is a registration candidate until AIUser and
 * the deployment host return live registry/discovery acceptance.
 */

export const LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER =
  "https://passport.hibcglobal.com" as const;
export const LINGHAO_PASSPORT_V4_PRODUCTION_ORIGIN =
  "https://play.hibcglobal.com" as const;
export const LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID =
  "aistory-production-passport-v4-web" as const;
export const LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK =
  "https://play.hibcglobal.com/api/auth/linghao-passport-v4/callback" as const;
export const LINGHAO_PASSPORT_V4_PRODUCTION_POST_LOGOUT =
  "https://play.hibcglobal.com/auth/linghao-passport-v4" as const;
export const LINGHAO_PASSPORT_V4_PRODUCTION_RETURN_PATH =
  "/auth/linghao-passport-v4" as const;
export const LINGHAO_PASSPORT_V4_PRODUCTION_SCOPES = Object.freeze([
  "openid",
  "profile",
  "email",
] as const);

export type LinghaoPassportV4PublicAccount = Readonly<{
  authType: "passport_v4";
  displayName: "灵号通行证用户";
  status: "active";
  expiresAt: number;
  balance: null;
  ledger: readonly [];
  capabilities: Readonly<{
    ordinaryProductAccess: true;
    newContentNamespace: true;
    legacyAccountRead: false;
    legacyAccountLink: false;
    administrator: false;
    phoneAccount: false;
    formalWallet: false;
    platformPaidGeneration: false;
    cloudProgress: false;
    hostedByok: false;
  }>;
}>;

