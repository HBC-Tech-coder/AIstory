import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthModal } from "@/components/AuthModal";
import { I18nProvider } from "@/lib/i18n/client";
import { DEFAULT_LOCALE } from "@/lib/i18n/config";
import { zhCN } from "@/lib/i18n/locales/zh-CN";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => {
    fetchCalls += 1;
    throw new Error("network forbidden");
  },
});

try {
  assert.throws(
    () => renderToStaticMarkup(
      <AuthModal onClose={() => undefined} onSuccess={() => undefined} />,
    ),
    /useI18n must be used within I18nProvider/,
  );

  const wrapped = renderToStaticMarkup(
    <I18nProvider
      initialLocale={DEFAULT_LOCALE}
      initialTranslations={zhCN as Record<string, unknown>}
    >
      <AuthModal onClose={() => undefined} onSuccess={() => undefined} />
    </I18nProvider>,
  );
  assert.match(wrapped, /role="dialog"/);
  assert.match(wrapped, /手机号/);
  assert.match(wrapped, /aria-modal="true"/);

  const root = process.cwd();
  const [pageSource, formSource, modalSource] = await Promise.all([
    readFile(path.join(root, "app/admin/login/page.tsx"), "utf8"),
    readFile(path.join(root, "app/admin/login/AdminLoginForm.tsx"), "utf8"),
    readFile(path.join(root, "components/AuthModal.tsx"), "utf8"),
  ]);
  const providerStart = pageSource.indexOf("<I18nProvider");
  const formStart = pageSource.indexOf("<AdminLoginForm");
  const providerEnd = pageSource.indexOf("</I18nProvider>");
  assert.ok(providerStart > 0);
  assert.ok(formStart > providerStart);
  assert.ok(providerEnd > formStart);
  assert.match(pageSource, /loadTranslations\(DEFAULT_LOCALE\)/);
  assert.match(pageSource, /initialLocale=\{DEFAULT_LOCALE\}/);
  assert.doesNotMatch(formSource, /AuthModal|setShowPhoneLogin/);
  assert.equal((formSource.match(/<AuthModal/g) ?? []).length, 0);
  assert.match(formSource, /独立管理员账号/);
  assert.match(formSource, /高熵密码/);
  assert.doesNotMatch(formSource, /\/api\/admin\/bootstrap/);
  assert.doesNotMatch(formSource, /enterAdminAfterIdentity/);
  assert.doesNotMatch(pageSource, /readPhoneUserSession/);
  assert.doesNotMatch(
    formSource,
    /\/api\/auth\/phone\/(?:request|verify)/,
    "the independent administrator page must not implement or invoke phone OTP",
  );
  assert.match(modalSource, /const \{ t \} = useI18n\(\)/);
  assert.equal(fetchCalls, 0);
  console.log("admin login i18n boundary tests passed");
} finally {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
}
