import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  aiUserPublicAccount,
  resolveAiUserLinkedBillingBalance,
} from "@/lib/auth/aiUserAccountPublic";

const expiresAt = 1_900_000_000_000;

const unlinked = aiUserPublicAccount(expiresAt, {
  accountLinked: false,
  balance: null,
  platformBilling: false,
});
assert.equal(resolveAiUserLinkedBillingBalance(unlinked), null);

const linkedButDisabled = aiUserPublicAccount(expiresAt, {
  accountLinked: true,
  balance: 998,
  platformBilling: false,
});
assert.equal(resolveAiUserLinkedBillingBalance(linkedButDisabled), null);

const linked = aiUserPublicAccount(expiresAt, {
  accountLinked: true,
  balance: 998,
  platformBilling: true,
});
assert.equal(resolveAiUserLinkedBillingBalance(linked), 998);

const invalidBalance = aiUserPublicAccount(expiresAt, {
  accountLinked: true,
  balance: Number.NaN,
  platformBilling: true,
});
assert.equal(resolveAiUserLinkedBillingBalance(invalidBalance), null);

const creditBalanceSource = await readFile(
  path.join(process.cwd(), "components", "CreditBalance.tsx"),
  "utf8",
);
const userChipSource = await readFile(
  path.join(process.cwd(), "components", "UserChip.tsx"),
  "utf8",
);
const verifyRouteSource = await readFile(
  path.join(
    process.cwd(),
    "app",
    "api",
    "auth",
    "phone",
    "verify",
    "route.ts",
  ),
  "utf8",
);
const accountLogoutSource = await readFile(
  path.join(process.cwd(), "lib", "auth", "accountLogoutRoute.ts"),
  "utf8",
);

assert.match(creditBalanceSource, /source: "aiuser_linked_phone"/);
assert.match(creditBalanceSource, /resolveAiUserLinkedBillingBalance/);
assert.match(userChipSource, /Linked Billing/);
assert.match(userChipSource, /未关联手机号账户/);
assert.match(creditBalanceSource, /PASSPORT_V4_SESSION_UNAVAILABLE/);
assert.match(creditBalanceSource, /passport_no_wallet/);
assert.match(userChipSource, /passportActive\.current/);
assert.match(userChipSource, /!aiuserActive\.current && !wasPassport/);
assert.match(accountLogoutSource, /Passport logout is deliberately isolated/);
assert.doesNotMatch(
  verifyRouteSource,
  /betaCreditMembership/,
  "the internal beta membership capability must stay out of the phone response",
);

console.log("account identity projection tests passed");
