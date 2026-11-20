export const AIUSER_LINK_ENV = "AISTORY_AIUSER_ACCOUNT_LINK_MODE";
export const AIUSER_LINK_MODE = "aistory-aiuser-explicit-account-link-v1:enabled";
export const AIUSER_LINK_REVOCATION_ENV = "AISTORY_AIUSER_ACCOUNT_LINK_REVOCATION_MODE";
export const AIUSER_LINK_REVOCATION_MODE = "aistory-aiuser-explicit-account-link-revocation-v1:enabled";

/**
 * Revocation deliberately has a sticky, independent selector. Operators enable
 * it after the database gate and before admission, and keep it enabled while
 * disabling/draining admission so an older worker cannot confirm after logout.
 */
export function aiUserAccountLinkRevocationSelected(): boolean {
  return process.env[AIUSER_LINK_REVOCATION_ENV] === AIUSER_LINK_REVOCATION_MODE;
}

export function aiUserAccountLinkSelected(): boolean {
  return process.env[AIUSER_LINK_ENV] === AIUSER_LINK_MODE
    && aiUserAccountLinkRevocationSelected();
}
