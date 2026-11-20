"use client";

import { useRef, useState } from "react";

function requestId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `ccr_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function CreditCardRedeemPanel() {
  const [cardNumber, setCardNumber] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const requestKey = useRef(requestId());
  const requestInFlight = useRef(false);

  const changeCardNumber = (value: string) => {
    setCardNumber(value);
    requestKey.current = requestId();
  };

  const changePin = (value: string) => {
    setPin(value);
    requestKey.current = requestId();
  };

  const redeem = async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/credit-cards/redeem", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardNumber,
          pin,
          idempotencyKey: requestKey.current,
        }),
      });
      const result = await response.json() as { creditedCredits?: number };
      if (response.status === 401) {
        throw new Error("请先登录普通用户账户后再兑换。");
      }
      if (response.status === 429) {
        throw new Error("尝试次数过多，请稍后再试。");
      }
      if (!response.ok || !Number.isSafeInteger(result.creditedCredits)) {
        throw new Error("该积分卡暂不可用，请核对后稍后重试。");
      }
      setCardNumber("");
      setPin("");
      requestKey.current = requestId();
      setMessage(`兑换成功，已增加 ${result.creditedCredits} 积分。`);
      window.dispatchEvent(new Event("aistory:account-changed"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "该积分卡暂不可用。");
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto max-w-lg space-y-5 rounded-2xl border bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-2xl font-semibold">兑换积分卡</h1>
        <p className="mt-2 text-sm text-stone-600">卡号与一次性 PIN 仅用于本次安全兑换。</p>
      </header>
      <label className="block text-sm">卡号
        <input autoComplete="off" className="mt-1 w-full rounded border p-3 font-mono" value={cardNumber} onChange={(event) => changeCardNumber(event.target.value)} />
      </label>
      <label className="block text-sm">PIN
        <input autoComplete="off" className="mt-1 w-full rounded border p-3 font-mono" type="password" value={pin} onChange={(event) => changePin(event.target.value)} />
      </label>
      <button className="w-full rounded bg-stone-900 px-4 py-3 text-white disabled:opacity-50" disabled={busy || !cardNumber.trim() || !pin.trim()} onClick={redeem}>
        {busy ? "兑换中…" : "确认兑换"}
      </button>
      {message ? <p role="status" className="rounded border bg-stone-50 p-3 text-sm">{message}</p> : null}
    </section>
  );
}
