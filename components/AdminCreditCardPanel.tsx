"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import type {
  CreditCardAdminSnapshot,
  CreditCardBatchSummary,
  CreditCardOneTimeDelivery,
} from "@/lib/billing/creditCards";

type IssueResult = Readonly<{
  deliveryAvailable?: boolean;
  oneTimeDelivery?: CreditCardOneTimeDelivery;
}>;

function requestId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `ccr_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function post(body: Record<string, unknown>): Promise<Response> {
  const response = await fetch("/api/admin/credit-cards", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    window.location.assign("/admin/login?state=session-ended");
  }
  return response;
}

function BatchRow({ batch, onDisable }: {
  batch: CreditCardBatchSummary;
  onDisable: (batchId: string) => void;
}) {
  return (
    <tr className="border-t border-stone-200 text-sm">
      <td className="px-3 py-3 font-mono text-xs">{batch.batchId}</td>
      <td className="px-3 py-3">{batch.denominationCredits}</td>
      <td className="px-3 py-3">{batch.quantity}</td>
      <td className="px-3 py-3">{batch.redeemedCount}</td>
      <td className="px-3 py-3">{batch.remainingCount}</td>
      <td className="px-3 py-3">{batch.disabledCount}</td>
      <td className="px-3 py-3">{batch.expiredCount}</td>
      <td className="px-3 py-3">{batch.state}</td>
      <td className="px-3 py-3">
        {batch.state !== "disabled" ? (
          <button className="rounded border px-2 py-1" onClick={() => onDisable(batch.batchId)}>
            禁用未兑换卡
          </button>
        ) : null}
      </td>
    </tr>
  );
}

export function AdminCreditCardPanel() {
  const [snapshot, setSnapshot] = useState<CreditCardAdminSnapshot>();
  const [denomination, setDenomination] = useState("");
  const [validity, setValidity] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [cardToDisable, setCardToDisable] = useState("");
  const [delivery, setDelivery] = useState<CreditCardOneTimeDelivery>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const issueRequestId = useRef(requestId());
  const mutationInFlight = useRef(false);

  const load = async () => {
    const response = await fetch("/api/admin/credit-cards", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.assign("/admin/login?state=session-ended");
      throw new Error("管理员会话已结束。");
    }
    if (!response.ok) throw new Error("积分卡服务当前不可用。请检查服务端门禁。");
    const value = await response.json() as CreditCardAdminSnapshot;
    setSnapshot(value);
    setDenomination((current) => current || String(value.allowedDenominations[0] ?? ""));
    setValidity((current) => current || String(value.allowedValidityDays[0] ?? ""));
  };

  useEffect(() => {
    void load().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "积分卡服务当前不可用。");
    });
  }, []);

  useEffect(() => {
    const clearOneTimeDelivery = () => setDelivery(undefined);
    window.addEventListener("pagehide", clearOneTimeDelivery);
    return () => window.removeEventListener("pagehide", clearOneTimeDelivery);
  }, []);

  const total = useMemo(
    () => Number(denomination || 0) * Number(quantity || 0),
    [denomination, quantity],
  );

  const issue = async () => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    setDelivery(undefined);
    setMessage("");
    try {
      const response = await post({
        action: "issue",
        denominationCredits: Number(denomination),
        quantity: Number(quantity),
        validityDays: Number(validity),
        idempotencyKey: issueRequestId.current,
      });
      const result = await response.json() as IssueResult;
      if (!response.ok || !result.deliveryAvailable || !result.oneTimeDelivery) {
        throw new Error("生成失败；系统不会在重放时再次显示卡密。");
      }
      setDelivery(result.oneTimeDelivery);
      issueRequestId.current = requestId();
      setMessage("卡密只在此页面内存中显示一次。确认保存后再激活批次。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成失败。");
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!delivery) return;
    setBusy(true);
    try {
      const response = await post({
        action: "activate",
        batchId: delivery.batchId,
        activationToken: delivery.activationToken,
      });
      if (!response.ok) throw new Error("激活失败；卡仍不可兑换。");
      setDelivery(undefined);
      setMessage("批次已激活；一次性卡密已从页面清除。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "激活失败。");
    } finally {
      setBusy(false);
    }
  };

  const disable = async (batchId: string) => {
    setBusy(true);
    try {
      const response = await post({ action: "disable_batch", batchId });
      if (!response.ok) throw new Error("禁用失败。");
      setMessage("批次中所有未兑换卡已禁用。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "禁用失败。");
    } finally {
      setBusy(false);
    }
  };

  const disableOneCard = async () => {
    if (!cardToDisable.trim() || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusy(true);
    try {
      const response = await post({
        action: "disable_card",
        cardNumber: cardToDisable,
      });
      if (!response.ok) throw new Error("该积分卡无法禁用。");
      setCardToDisable("");
      setMessage("指定未兑换卡已禁用。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "禁用失败。");
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">管理员积分卡</h1>
        <p className="mt-2 text-sm text-stone-600">
          仅生成服务端策略允许的固定面额。卡号和 PIN 不会进入历史、日志或批次摘要。
        </p>
        <Link className="mt-2 inline-block text-sm underline" href="/admin">
          返回管理员控制台
        </Link>
      </header>

      {snapshot ? (
        <div className="grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-4">
          <label className="text-sm">面额
            <select className="mt-1 block w-full rounded border p-2" value={denomination} onChange={(event) => setDenomination(event.target.value)}>
              {snapshot.allowedDenominations.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="text-sm">数量
            <input className="mt-1 block w-full rounded border p-2" type="number" min={1} max={snapshot.maxBatchCount} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </label>
          <label className="text-sm">有效天数
            <select className="mt-1 block w-full rounded border p-2" value={validity} onChange={(event) => setValidity(event.target.value)}>
              {snapshot.allowedValidityDays.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <button className="w-full rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy || !!delivery || total < 1 || total > snapshot.maxBatchCredits} onClick={issue}>
              生成一次性卡密
            </button>
          </div>
        </div>
      ) : null}

      {message ? <p role="status" className="rounded border bg-stone-50 p-3 text-sm">{message}</p> : null}

      {snapshot ? (
        <div className="flex flex-col gap-2 rounded-xl border bg-white p-4 md:flex-row md:items-end">
          <label className="flex-1 text-sm">禁用单张未兑换卡
            <input autoComplete="off" className="mt-1 block w-full rounded border p-2 font-mono" value={cardToDisable} onChange={(event) => setCardToDisable(event.target.value)} />
          </label>
          <button className="rounded border border-red-700 px-4 py-2 text-red-800 disabled:opacity-50" disabled={busy || !cardToDisable.trim()} onClick={disableOneCard}>
            禁用此卡
          </button>
        </div>
      ) : null}

      {delivery ? (
        <section className="rounded-xl border-2 border-amber-500 bg-amber-50 p-5" data-one-time-delivery>
          <h2 className="font-semibold">一次性显示（刷新即消失）</h2>
          <p className="mt-1 text-sm">批次：{delivery.batchId}</p>
          <div className="mt-4 max-h-80 overflow-auto rounded bg-white p-3 font-mono text-sm">
            {delivery.cards.map((card) => (
              <p key={card.cardNumber}>{card.cardNumber}　{card.pin}</p>
            ))}
          </div>
          <button className="mt-4 rounded bg-emerald-700 px-4 py-2 text-white disabled:opacity-50" disabled={busy} onClick={activate}>
            已安全保存，激活批次
          </button>
        </section>
      ) : null}

      <div className="overflow-auto rounded-xl border bg-white">
        <table className="w-full min-w-[900px] text-left">
          <thead className="bg-stone-50 text-xs text-stone-600"><tr>
            {['批次','面额','数量','已兑','未兑','禁用','过期','状态','操作'].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}
          </tr></thead>
          <tbody>{snapshot?.batches.map((batch) => <BatchRow key={batch.batchId} batch={batch} onDisable={disable} />)}</tbody>
        </table>
      </div>
    </section>
  );
}
