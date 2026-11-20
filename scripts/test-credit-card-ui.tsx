import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminCreditCardPanel } from "../components/AdminCreditCardPanel";
import { CreditCardRedeemPanel } from "../components/CreditCardRedeemPanel";

async function main() {
  const adminMarkup = renderToStaticMarkup(<AdminCreditCardPanel />);
  const userMarkup = renderToStaticMarkup(<CreditCardRedeemPanel />);
  assert.match(adminMarkup, /管理员积分卡/);
  assert.match(adminMarkup, /服务端策略允许的固定面额/);
  assert.match(userMarkup, /兑换积分卡/);
  assert.match(userMarkup, /type="password"/);
  assert.doesNotMatch(adminMarkup + userMarkup, /手机号|OTP|provider|secret/i);

  const files = [
    "components/AdminCreditCardPanel.tsx",
    "components/CreditCardRedeemPanel.tsx",
    "app/admin/credit-cards/page.tsx",
    "app/[locale]/account/credit-card/page.tsx",
  ];
  const sources = await Promise.all(files.map((file) => (
    readFile(path.join(process.cwd(), file), "utf8")
  )));
  const clientSources = sources.slice(0, 2).join("\n");
  for (const forbidden of [
    "localStorage", "sessionStorage", "indexedDB", "clipboard",
    "download=", "console.", "creditCardsServer", "AuthModal", "phone",
  ]) assert.equal(clientSources.includes(forbidden), false, forbidden);
  assert.equal(clientSources.includes("allowedDenominations.map"), true);
  assert.equal(clientSources.includes("allowedValidityDays.map"), true);
  assert.equal(clientSources.includes("data-one-time-delivery"), true);
  assert.equal(clientSources.includes("setDelivery(undefined)"), true);
  assert.equal(clientSources.includes('addEventListener("pagehide"'), true);
  assert.equal(clientSources.includes('action: "disable_card"'), true);
  assert.equal(clientSources.includes("setCardNumber(\"\")"), true);
  assert.equal(clientSources.includes("setPin(\"\")"), true);
  assert.equal(sources[2]!.includes('actor.mode !== "independent"'), true);
  const server = createServer((request, response) => {
    const body = request.url === "/admin/credit-cards"
      ? adminMarkup
      : request.url === "/zh-CN/account/credit-card"
        ? userMarkup
        : "not found";
    response.writeHead(body === "not found" ? 404 : 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal([4200, 4107, 5679, 8188].includes(address.port), false);
    const readLoopback = (pathname: string) => new Promise<string>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}${pathname}`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve(body));
      }).once("error", reject);
    });
    assert.match(await readLoopback("/admin/credit-cards"), /管理员积分卡/);
    assert.match(await readLoopback("/zh-CN/account/credit-card"), /兑换积分卡/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("credit-card UI tests: PASS (memory-only reveal, fixed policy choices, independent-admin and phone-route boundaries)");
}

void main();
