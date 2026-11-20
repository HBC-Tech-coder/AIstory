"use client";

import { useMemo, useState } from "react";
import { AdminVideoAssetsPanel } from "@/components/AdminVideoAssetsPanel";
import { AdminVideoStoryComposer } from "@/components/AdminVideoStoryComposer";
import { AdminVideoWorkflowABPanel } from "@/components/AdminVideoWorkflowABPanel";
import { AdminGpuCoordinatorPanel } from "@/components/AdminGpuCoordinatorPanel";
import { AdminRoleManagementPanel } from "@/components/AdminRoleManagementPanel";
import type {
  AdminActorPublic,
  AdminSnapshot,
  PriceCatalogEntry,
  PaymentProvider,
  PlatformBranding,
  PlatformProviderModality,
} from "@/lib/admin/types";

type Tab =
  | "overview"
  | "users"
  | "roles"
  | "credits"
  | "analytics"
  | "payments"
  | "integrations"
  | "branding"
  | "domains"
  | "channels"
  | "videos"
  | "video-ab"
  | "video-stories"
  | "gpu-coordinator"
  | "audit";

const NAV: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "overview", label: "总览", icon: "fa-chart-pie" },
  { id: "users", label: "用户管理", icon: "fa-users" },
  { id: "roles", label: "角色清单", icon: "fa-user-shield" },
  { id: "credits", label: "积分中心", icon: "fa-coins" },
  { id: "analytics", label: "行为与成本", icon: "fa-chart-line" },
  { id: "integrations", label: "平台集成", icon: "fa-plug" },
  { id: "payments", label: "支付配置", icon: "fa-credit-card" },
  { id: "branding", label: "平台与品牌", icon: "fa-palette" },
  { id: "domains", label: "域名", icon: "fa-globe" },
  { id: "channels", label: "白标与渠道", icon: "fa-diagram-project" },
  { id: "videos", label: "视频资产", icon: "fa-film" },
  { id: "video-ab", label: "A/B 视频实验", icon: "fa-scale-balanced" },
  { id: "video-stories", label: "互动视频剧情", icon: "fa-code-branch" },
  { id: "gpu-coordinator", label: "GPU LAN LAB", icon: "fa-microchip" },
  { id: "audit", label: "审计中心", icon: "fa-shield-halved" },
];

const PAYMENT_PROVIDERS: Array<{ id: PaymentProvider; name: string }> = [
  { id: "wechat_pay", name: "微信支付" },
  { id: "alipay", name: "支付宝" },
  { id: "stripe", name: "Stripe" },
  { id: "steam", name: "Steam" },
  { id: "apple_iap", name: "Apple IAP" },
  { id: "google_play", name: "Google Play Billing" },
];

function Metric({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string | number;
  suffix?: string;
}) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-5">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-stone-900">
        {value}
        {suffix ? <span className="ml-1 text-sm text-stone-500">{suffix}</span> : null}
      </p>
    </div>
  );
}

function Empty({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-12 text-center">
      <p className="font-medium text-stone-800">{title}</p>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-500">{detail}</p>
    </div>
  );
}

export function AdminConsole({
  initialSnapshot,
  actor,
}: {
  initialSnapshot: AdminSnapshot;
  actor: AdminActorPublic;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [branding, setBranding] = useState<PlatformBranding>(
    initialSnapshot.resolvedBranding,
  );
  const [publishReason, setPublishReason] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [paymentProvider, setPaymentProvider] =
    useState<PaymentProvider>("stripe");
  const [paymentSecretReference, setPaymentSecretReference] = useState("");
  const [providerModality, setProviderModality] =
    useState<PlatformProviderModality>("text");
  const [providerName, setProviderName] = useState("openai_compatible");
  const [providerBaseUrl, setProviderBaseUrl] = useState("https://api.example.com/v1");
  const [providerModel, setProviderModel] = useState("");
  const [providerSecretReference, setProviderSecretReference] = useState("");
  const [domainName, setDomainName] = useState("");
  const [channelKind, setChannelKind] = useState<
    "web" | "steam" | "wechat_miniprogram" | "wechat_minigame" | "ios" | "android"
  >("web");
  const [channelName, setChannelName] = useState("");
  const [creditUserId, setCreditUserId] = useState(
    initialSnapshot.users[0]?.userId || "",
  );
  const [creditAmount, setCreditAmount] = useState("1000");
  const [creditReason, setCreditReason] = useState("");
  const [creditIdempotencyKey, setCreditIdempotencyKey] = useState("");
  const [billingVersion, setBillingVersion] = useState(
    initialSnapshot.billingPolicy.version === "unconfigured"
      ? ""
      : initialSnapshot.billingPolicy.version,
  );
  const [billingMultiplier, setBillingMultiplier] = useState(
    String(initialSnapshot.billingPolicy.markupBasisPoints / 10_000),
  );
  const [billingInitialGrant, setBillingInitialGrant] = useState(
    String(initialSnapshot.billingPolicy.initialGrantCredits),
  );
  const [billingCatalogJson, setBillingCatalogJson] = useState(
    JSON.stringify(initialSnapshot.billingPolicy.entries, null, 2),
  );

  const latestDraft = useMemo(
    () => snapshot.settingsVersions
      .filter((item) => item.status === "draft")
      .sort((a, b) => b.version - a.version)[0],
    [snapshot.settingsVersions],
  );
  const visibleUsers = useMemo(() => {
    const query = userQuery.trim().toLowerCase();
    if (!query) return snapshot.users;
    return snapshot.users.filter((user) =>
      [
        user.displayName,
        user.userId,
        user.status,
        user.userType,
        user.region || "",
        user.channelId || "web",
        ...user.tags,
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [snapshot.users, userQuery]);
  // The read-only role inventory is exposed only through the non-independent
  // super-admin path; the independent P0.5 actor keeps an empty roles projection.
  const canViewRoleInventory = actor.mode !== "independent"
    && actor.roles.includes("super_admin");
  const visibleNavigation = NAV.filter((item) => {
    if (item.id === "roles") return canViewRoleInventory;
    if (actor.mode === "independent") {
      return item.id === "overview" || item.id === "users";
    }
    return true;
  });

  async function act(body: Record<string, unknown>) {
    if (actor.mode === "independent") {
      setMessage("独立管理员当前仅开放只读控制台投影。");
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      window.location.assign("/admin/login?state=session-ended");
      return;
    }
    const result = await response.json() as {
      error?: string;
      snapshot?: AdminSnapshot;
    };
    setBusy(false);
    if (!response.ok || !result.snapshot) {
      setMessage(result.error || "操作失败");
      return;
    }
    setSnapshot(result.snapshot);
    setMessage("操作已完成并写入审计日志");
  }

  async function logout() {
    const response = await fetch("/api/admin/session", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    window.location.assign(
      response.ok
        ? "/admin/login"
        : "/admin/login?state=session-ended",
    );
  }

  const overview = snapshot.overview;
  return (
    <main className="ui-page min-h-screen text-stone-900">
      <header className="ui-surface sticky top-0 z-20 border-b px-4 py-3 backdrop-blur md:px-7">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-ember-500 font-serif text-xl text-white">
              A
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-semibold">AIstory 超级管理员控制台</h1>
              <p className="text-xs text-stone-500">服务端领域模型 · P1</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-900 sm:px-3 sm:text-xs">
              {actor.mode === "independent" ? (
                <span>生产安全只读</span>
              ) : (
                <>
                  <span className="sm:hidden">本地数据</span>
                  <span className="hidden sm:inline">本地开发数据</span>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={logout}
              className="rounded-lg border border-stone-300 px-3 py-2 text-sm hover:bg-white"
            >
              退出
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] md:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="border-b border-stone-200 bg-white/50 p-3 md:min-h-[calc(100vh-65px)] md:border-b-0 md:border-r md:p-4">
          <nav className="flex gap-2 overflow-x-auto pb-1 md:block md:space-y-1">
            {visibleNavigation.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition md:w-full ${
                  tab === item.id
                    ? "bg-ember-500 text-white"
                    : "text-stone-600 hover:bg-white hover:text-stone-900"
                }`}
              >
                <i className={`fa-solid ${item.icon} w-4`} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="mt-6 hidden rounded-xl border border-stone-200 bg-white p-3 text-xs leading-5 text-stone-500 md:block">
            <p className="font-medium text-stone-700">
              {actor.mode === "independent" ? "独立管理员" : "管理员会话"}
            </p>
            <p>{actor.roles.join(" / ")}</p>
            <p className="mt-2">此视图仅显示当前授权范围内的安全摘要。</p>
          </div>
        </aside>

        <section className="min-w-0 p-4 md:p-7">
          {message ? (
            <p className="mb-4 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm">
              {message}
            </p>
          ) : null}

          {tab === "overview" ? (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-semibold">总览</h2>
                <p className="mt-1 text-sm text-stone-500">
                  {overview.statisticsEnabled
                    ? "聚合结构化事件，不包含私人提示词或完整剧情正文。"
                    : "尚未启用服务端统计，所有指标为真实的零值。"}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric label="注册用户" value={overview.registeredUsers} />
                <Metric label="活跃用户" value={overview.activeUsers} />
                <Metric label="游玩次数" value={overview.playSessions} />
                <Metric label="完成次数" value={overview.completedSessions} />
                <Metric label="分支选择" value={overview.choiceSelections} />
                <Metric label="生成调用" value={overview.generationCalls} />
                <Metric
                  label="缓存命中"
                  value={(overview.cacheHitRate * 100).toFixed(1)}
                  suffix="%"
                />
                <Metric
                  label="API 估算成本"
                  value={overview.estimatedProviderCost.toFixed(4)}
                  suffix="估算"
                />
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <Metric label="积分发放" value={overview.creditsGranted} />
                <Metric label="积分消费" value={overview.creditsSpent} />
                <Metric label="限流 / 失败" value={`${overview.rateLimited} / ${overview.failures}`} />
              </div>
            </div>
          ) : null}

          {tab === "users" ? (
            <div className="space-y-5">
              <h2 className="text-2xl font-semibold">用户管理</h2>
              <input
                type="search"
                value={userQuery}
                onChange={(event) => setUserQuery(event.target.value)}
                placeholder="搜索用户、状态、类型、地区或渠道"
                className="w-full max-w-xl rounded-xl border border-stone-300 bg-white px-4 py-3 text-sm outline-none focus:border-ember-500"
              />
              {snapshot.users.length ? (
                <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="bg-stone-50 text-stone-500">
                      <tr>
                        {["用户", "状态", "渠道", "地区", "积分", "游玩", "估算成本"].map((item) => (
                          <th key={item} className="px-4 py-3 font-medium">{item}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleUsers.map((user) => (
                        <tr key={user.userId} className="border-t border-stone-100">
                          <td className="px-4 py-3">{user.displayName}</td>
                          <td className="px-4 py-3">{user.status}</td>
                          <td className="px-4 py-3">{user.channelId || "web"}</td>
                          <td className="px-4 py-3">{user.region || "—"}</td>
                          <td className="px-4 py-3">{user.creditBalance}</td>
                          <td className="px-4 py-3">{user.playCount}</td>
                          <td className="px-4 py-3">{user.estimatedCost.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="暂无服务端用户"
                  detail="浏览器匿名积分账本不会被当作服务端账户。用户详情未来只展示结构化时间线和选择路径，不默认展示私人正文。"
                />
              )}
            </div>
          ) : null}

          {tab === "credits" ? (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-semibold">积分中心</h2>
                <p className="mt-1 text-sm text-stone-500">
                  新用户默认 {snapshot.resolvedBranding.defaultInitialCredits.toLocaleString("zh-CN")} 积分；修改仅影响之后创建的服务端账户。
                </p>
              </div>
              <div className="grid gap-5 xl:grid-cols-2">
                <form
                  className="rounded-2xl border border-stone-200 bg-white p-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const key = creditIdempotencyKey.trim()
                      || `admin_grant:${crypto.randomUUID()}`;
                    setCreditIdempotencyKey(key);
                    void act({
                      action: "credit.adjust",
                      userId: creditUserId,
                      amount: Number(creditAmount),
                      reason: creditReason,
                      idempotencyKey: key,
                    });
                  }}
                >
                  <h3 className="font-medium">内测用户积分赠送 / 调整</h3>
                  <p className="mt-1 text-xs leading-relaxed text-stone-500">
                    只能追加不可变流水，不能直接改余额。原因、operator、幂等键与调整前后余额会写入审计。
                  </p>
                  <div className="mt-4 grid gap-3">
                    <select
                      value={creditUserId}
                      onChange={(event) => setCreditUserId(event.target.value)}
                      className="rounded-xl border border-stone-300 px-3 py-2.5"
                      required
                    >
                      <option value="">选择服务端账户</option>
                      {snapshot.users.map((user) => (
                        <option key={user.userId} value={user.userId}>
                          {user.displayName} · {user.maskedContact || user.userId} · {user.creditBalance} 积分
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="1"
                      value={creditAmount}
                      onChange={(event) => setCreditAmount(event.target.value)}
                      placeholder="正数赠送，负数扣回"
                      className="rounded-xl border border-stone-300 px-3 py-2.5"
                      required
                    />
                    <input
                      value={creditReason}
                      onChange={(event) => setCreditReason(event.target.value)}
                      placeholder="必填：调整原因"
                      minLength={3}
                      className="rounded-xl border border-stone-300 px-3 py-2.5"
                      required
                    />
                    <input
                      value={creditIdempotencyKey}
                      onChange={(event) =>
                        setCreditIdempotencyKey(event.target.value)
                      }
                      placeholder="幂等键（留空自动生成）"
                      className="rounded-xl border border-stone-300 px-3 py-2.5 font-mono text-xs"
                    />
                    <button
                      type="submit"
                      disabled={busy || !creditUserId}
                      className="rounded-xl bg-ember-500 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      追加积分流水
                    </button>
                  </div>
                </form>

                <form
                  className="rounded-2xl border border-stone-200 bg-white p-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    try {
                      const entries = JSON.parse(billingCatalogJson) as PriceCatalogEntry[];
                      void act({
                        action: "billing.policy.save",
                        policy: {
                          version: billingVersion,
                          markupBasisPoints: Math.round(
                            Number(billingMultiplier) * 10_000,
                          ),
                          initialGrantCredits: Number(billingInitialGrant),
                          providerCurrency:
                            snapshot.billingPolicy.providerCurrency || "CNY",
                          providerMinorUnitScale:
                            snapshot.billingPolicy.providerMinorUnitScale || 2,
                          creditUnitsPerProviderMinor:
                            snapshot.billingPolicy.creditUnitsPerProviderMinor || 1,
                          entries,
                        },
                        reason: `发布定价策略 ${billingVersion}`,
                      });
                    } catch {
                      setMessage("模型价目表必须是有效 JSON 数组");
                    }
                  }}
                >
                  <h3 className="font-medium">PricePolicy</h3>
                  <p className="mt-1 text-xs leading-relaxed text-stone-500">
                    默认倍率 2.0；成本使用最小货币单位整数，积分向上取整。无启用价目时平台调用 fail-closed。
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <input
                      value={billingVersion}
                      onChange={(event) => setBillingVersion(event.target.value)}
                      placeholder="价目版本，例如 2026.07-p1"
                      className="rounded-xl border border-stone-300 px-3 py-2.5"
                      required
                    />
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="0.01"
                      value={billingMultiplier}
                      onChange={(event) => setBillingMultiplier(event.target.value)}
                      placeholder="定价倍数"
                      className="rounded-xl border border-stone-300 px-3 py-2.5"
                      required
                    />
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={billingInitialGrant}
                      onChange={(event) => setBillingInitialGrant(event.target.value)}
                      placeholder="注册首赠"
                      className="rounded-xl border border-stone-300 px-3 py-2.5 sm:col-span-2"
                      required
                    />
                    <textarea
                      value={billingCatalogJson}
                      onChange={(event) => setBillingCatalogJson(event.target.value)}
                      rows={10}
                      aria-label="模型价目表 JSON"
                      className="rounded-xl border border-stone-300 px-3 py-2.5 font-mono text-xs sm:col-span-2"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-xl bg-ember-500 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 sm:col-span-2"
                    >
                      保存版本化定价策略
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ) : null}

          {tab === "analytics" ? (
            <div className="space-y-5">
              <h2 className="text-2xl font-semibold">行为与成本</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric label="匿名转登录" value={overview.anonymousToAccountConversions} />
                <Metric label="积分预授权" value={overview.creditReservations} />
                <Metric label="结算笔数" value={overview.creditSettlements} />
                <Metric label="失败/取消退回" value={overview.creditRefunds} />
                <Metric label="供应商成本（最小单位）" value={overview.providerCostMinor} />
                <Metric label="平台实扣积分" value={overview.chargedCredits} />
              </div>
              <Empty
                title="尚未启用服务端统计"
                detail="事件模型已覆盖作品、节点、分支、渠道、设备、provider、模态、模型、延迟、缓存命中、429、失败与估算成本；P1 不采集提示词或完整剧情内容。"
              />
            </div>
          ) : null}

          {tab === "integrations" ? (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-semibold">平台模型集成</h2>
                <p className="mt-1 text-sm text-stone-500">
                  平台凭据与玩家“我的 API（BYOK）”物理分离。这里只保存服务端密钥引用；公开外测默认不开放平台积分调用。
                </p>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {snapshot.providerConfigs.map((config) => (
                  <article key={config.id} className="rounded-2xl border border-stone-200 bg-white p-5">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="font-medium">{config.modality.toUpperCase()} · {config.provider}</h3>
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
                        {config.status}
                      </span>
                    </div>
                    <p className="mt-3 truncate text-sm text-stone-600">{config.model || "未设置模型"}</p>
                    <p className="mt-1 text-xs text-stone-400">{config.secretReference || "未设置密钥引用"}</p>
                  </article>
                ))}
              </div>
              <div className="rounded-2xl border border-stone-200 bg-white p-5">
                <h3 className="font-medium">配置平台 Provider 元数据</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <select
                    value={providerModality}
                    onChange={(event) => setProviderModality(event.target.value as PlatformProviderModality)}
                    className="rounded-xl border border-stone-300 px-3 py-2.5"
                  >
                    {(["text", "image", "vision", "tts", "video"] as PlatformProviderModality[]).map((item) => (
                      <option key={item} value={item}>{item.toUpperCase()}</option>
                    ))}
                  </select>
                  <input value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="provider" className="rounded-xl border border-stone-300 px-3 py-2.5" />
                  <input value={providerBaseUrl} onChange={(event) => setProviderBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className="rounded-xl border border-stone-300 px-3 py-2.5" />
                  <input value={providerModel} onChange={(event) => setProviderModel(event.target.value)} placeholder="model / endpoint" className="rounded-xl border border-stone-300 px-3 py-2.5" />
                  <input value={providerSecretReference} onChange={(event) => setProviderSecretReference(event.target.value)} placeholder="env:TEXT_API_KEY 或 secret:path/name" className="rounded-xl border border-stone-300 px-3 py-2.5 md:col-span-2" />
                  <button
                    type="button"
                    disabled={busy || !providerModel.trim() || !providerSecretReference.trim()}
                    onClick={() => act({
                      action: "provider.save",
                      config: {
                        id: `provider-${providerModality}`,
                        tenantId: "platform",
                        modality: providerModality,
                        provider: providerName,
                        baseUrl: providerBaseUrl,
                        model: providerModel,
                        capabilities: [providerModality],
                        enabled: false,
                        status: "disabled",
                        secretReference: providerSecretReference,
                        updatedAt: new Date().toISOString(),
                      },
                      reason: "更新平台模型集成元数据",
                    })}
                    className="rounded-xl bg-ember-500 px-4 py-2.5 text-sm text-white disabled:opacity-50 md:col-span-2"
                  >
                    保存为停用配置
                  </button>
                </div>
                <p className="mt-3 text-xs text-stone-500">
                  密钥值不会写入此表单或返回浏览器；启用平台调用还需要服务端总开关和身份 allowlist。
                </p>
              </div>
            </div>
          ) : null}
          {tab === "payments" ? (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-semibold">支付配置</h2>
                <p className="mt-1 text-sm text-stone-500">
                  仅保存配置元数据与 secret reference；P1 不连接真实支付、不创建订单。
                </p>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {PAYMENT_PROVIDERS.map((provider) => {
                  const config = snapshot.paymentConfigs.find(
                    (item) => item.provider === provider.id,
                  );
                  return (
                    <article key={provider.id} className="rounded-2xl border border-stone-200 bg-white p-5">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-medium">{provider.name}</h3>
                        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
                          {config?.status || "未配置"}
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-stone-500">
                        {config?.secretReference || "未设置密钥引用"}
                      </p>
                      <p className="mt-1 text-xs text-stone-400">
                        webhook: {config?.webhookPath || `/api/webhooks/${provider.id}`}
                      </p>
                    </article>
                  );
                })}
              </div>
              <div className="rounded-2xl border border-stone-200 bg-white p-5">
                <h3 className="font-medium">配置沙盒元数据</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto]">
                  <select
                    value={paymentProvider}
                    onChange={(event) =>
                      setPaymentProvider(event.target.value as PaymentProvider)
                    }
                    className="rounded-xl border border-stone-300 px-3 py-2.5"
                  >
                    {PAYMENT_PROVIDERS.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={paymentSecretReference}
                    onChange={(event) => setPaymentSecretReference(event.target.value)}
                    placeholder="env:STRIPE_SECRET_KEY 或 secret:path/name"
                    className="rounded-xl border border-stone-300 px-3 py-2.5"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act({
                      action: "payment.save",
                      config: {
                        id: `payment-${paymentProvider}`,
                        tenantId: "platform",
                        provider: paymentProvider,
                        enabled: false,
                        sandbox: true,
                        status: "unconfigured",
                        secretReference: paymentSecretReference || undefined,
                        webhookPath: `/api/webhooks/${paymentProvider}`,
                        updatedAt: new Date().toISOString(),
                      },
                      reason: "更新支付沙盒配置元数据",
                    })}
                    className="rounded-xl bg-ember-500 px-4 py-2.5 text-sm text-white disabled:opacity-50"
                  >
                    保存元数据
                  </button>
                </div>
                <p className="mt-3 text-xs text-stone-500">
                  不接受明文 secret；保存后也只显示掩码引用，不代表连接成功。
                </p>
              </div>
            </div>
          ) : null}

          {tab === "branding" ? (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-semibold">平台与品牌</h2>
                <p className="mt-1 text-sm text-stone-500">
                  先生成预览版本，再显式发布；渠道覆盖优先于租户，租户优先于平台。
                </p>
              </div>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="grid gap-4 rounded-2xl border border-stone-200 bg-white p-5 sm:grid-cols-2">
                  {([
                    ["projectName", "项目名"],
                    ["shortName", "短名"],
                    ["primaryColor", "主题色"],
                    ["defaultLocale", "默认语言"],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="text-xs text-stone-500">{label}</span>
                      <input
                        value={String(branding[key as keyof PlatformBranding] || "")}
                        onChange={(event) => setBranding({
                          ...branding,
                          [key]: event.target.value,
                        })}
                        className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5 outline-none focus:border-ember-500"
                      />
                    </label>
                  ))}
                  {([
                    ["logoUrl", "浅色 Logo URL"],
                    ["darkLogoUrl", "深色 Logo URL"],
                    ["faviconUrl", "Favicon URL"],
                    ["supportUrl", "客服链接"],
                    ["privacyUrl", "隐私政策链接"],
                    ["termsUrl", "服务条款链接"],
                    ["senderName", "邮件发件人"],
                    ["systemDomain", "系统域名"],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="text-xs text-stone-500">{label}</span>
                      <input
                        value={branding[key] || ""}
                        onChange={(event) => setBranding({
                          ...branding,
                          [key]: event.target.value,
                        })}
                        className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5 outline-none focus:border-ember-500"
                      />
                    </label>
                  ))}
                  <label className="block">
                    <span className="text-xs text-stone-500">新用户初始积分</span>
                    <input
                      type="number"
                      min={0}
                      value={branding.defaultInitialCredits}
                      onChange={(event) => setBranding({
                        ...branding,
                        defaultInitialCredits: Number(event.target.value),
                      })}
                      className="mt-2 w-full rounded-xl border border-stone-300 px-3 py-2.5 outline-none focus:border-ember-500"
                    />
                  </label>
                  <div className="flex items-end">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => act({ action: "branding.preview", branding })}
                      className="w-full rounded-xl bg-ember-500 px-4 py-2.5 text-white disabled:opacity-50"
                    >
                      保存预览版本
                    </button>
                  </div>
                </div>
                <aside className="rounded-2xl border border-stone-200 bg-white p-5">
                  <p className="text-xs text-stone-500">当前预览</p>
                  <div
                    className="mt-4 rounded-2xl p-5 text-white"
                    style={{ backgroundColor: branding.primaryColor }}
                  >
                    <p className="text-2xl font-semibold">{branding.projectName}</p>
                    <p className="mt-1 text-sm opacity-80">{branding.shortName}</p>
                  </div>
                  {latestDraft ? (
                    <div className="mt-5 space-y-3">
                      <p className="text-sm">草稿 v{latestDraft.version}</p>
                      <input
                        value={publishReason}
                        onChange={(event) => setPublishReason(event.target.value)}
                        placeholder="发布原因"
                        className="w-full rounded-xl border border-stone-300 px-3 py-2.5 text-sm"
                      />
                      <button
                        type="button"
                        disabled={busy || publishReason.trim().length < 3}
                        onClick={() => act({
                          action: "branding.publish",
                          versionId: latestDraft.id,
                          reason: publishReason,
                        })}
                        className="w-full rounded-xl border border-ember-500 px-4 py-2.5 text-ember-500 disabled:opacity-40"
                      >
                        发布此版本
                      </button>
                    </div>
                  ) : null}
                </aside>
              </div>
            </div>
          ) : null}

          {tab === "domains" ? (
            <div className="space-y-5">
              <h2 className="text-2xl font-semibold">域名</h2>
              <div className="flex flex-col gap-3 rounded-2xl border border-stone-200 bg-white p-5 sm:flex-row">
                <input
                  value={domainName}
                  onChange={(event) => setDomainName(event.target.value)}
                  placeholder="例如 admin.example.com"
                  className="min-w-0 flex-1 rounded-xl border border-stone-300 px-3 py-2.5"
                />
                <button
                  type="button"
                  disabled={busy || !domainName.trim()}
                  onClick={() => act({
                    action: "domain.save",
                    binding: {
                      id: `domain-${crypto.randomUUID()}`,
                      tenantId: "platform",
                      domain: domainName,
                      purpose: "canonical",
                    },
                    reason: "登记待验证域名",
                  })}
                  className="rounded-xl bg-ember-500 px-4 py-2.5 text-white disabled:opacity-50"
                >
                  保存待验证绑定
                </button>
              </div>
              {snapshot.domains.length ? snapshot.domains.map((domain) => (
                <article key={domain.id} className="rounded-2xl border border-stone-200 bg-white p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-medium">{domain.domain}</span>
                    <span className="text-sm text-amber-700">{domain.verificationStatus}</span>
                  </div>
                  <p className="mt-2 text-sm text-stone-500">
                    DNS {domain.dnsStatus} · 证书 {domain.certificateStatus} ·
                    基础设施尚未应用
                  </p>
                </article>
              )) : (
                <Empty
                  title="暂无域名绑定"
                  detail="保存绑定只会记录待验证状态，不会声称 Nginx、DNS 或证书已经生效；基础设施应用必须由独立受控任务执行。"
                />
              )}
            </div>
          ) : null}

          {tab === "channels" ? (
            <div className="space-y-5">
              <h2 className="text-2xl font-semibold">第三方、白标与渠道</h2>
              <div className="grid gap-3 rounded-2xl border border-stone-200 bg-white p-5 md:grid-cols-[220px_minmax(0,1fr)_auto]">
                <select
                  value={channelKind}
                  onChange={(event) =>
                    setChannelKind(event.target.value as typeof channelKind)
                  }
                  className="rounded-xl border border-stone-300 px-3 py-2.5"
                >
                  <option value="web">Web</option>
                  <option value="steam">Steam</option>
                  <option value="wechat_miniprogram">微信小程序</option>
                  <option value="wechat_minigame">微信小游戏</option>
                  <option value="ios">iOS</option>
                  <option value="android">Android</option>
                </select>
                <input
                  value={channelName}
                  onChange={(event) => setChannelName(event.target.value)}
                  placeholder="渠道应用名称"
                  className="rounded-xl border border-stone-300 px-3 py-2.5"
                />
                <button
                  type="button"
                  disabled={busy || !channelName.trim()}
                  onClick={() => act({
                    action: "channel.save",
                    app: {
                      id: `channel-${crypto.randomUUID()}`,
                      tenantId: "platform",
                      channelId: `${channelKind}-${Date.now()}`,
                      kind: channelKind,
                      name: channelName,
                      status: "draft",
                      authMethods: [],
                      paymentProviders: [],
                      redirectUris: [],
                      corsOrigins: [],
                      scopes: ["story:play"],
                      rateLimitPerMinute: 60,
                      updatedAt: new Date().toISOString(),
                    },
                    reason: "创建本地渠道草稿",
                  })}
                  className="rounded-xl bg-ember-500 px-4 py-2.5 text-white disabled:opacity-50"
                >
                  新建草稿
                </button>
              </div>
              {snapshot.channelApps.length ? snapshot.channelApps.map((app) => (
                <article key={app.id} className="rounded-2xl border border-stone-200 bg-white p-5">
                  <p className="font-medium">{app.name}</p>
                  <p className="mt-1 text-sm text-stone-500">{app.kind} · {app.status}</p>
                </article>
              )) : (
                <Empty
                  title="暂无渠道应用"
                  detail="模型已预留 Web、Steam、微信小程序/小游戏、iOS、Android 的独立登录、支付、版本、审核状态、预算、scopes、redirect URI、CORS 与速率限制。"
                />
              )}
            </div>
          ) : null}

          {tab === "videos" ? <AdminVideoAssetsPanel /> : null}
          {tab === "video-ab" ? <AdminVideoWorkflowABPanel /> : null}
          {tab === "video-stories" ? <AdminVideoStoryComposer /> : null}
          {tab === "gpu-coordinator" ? <AdminGpuCoordinatorPanel /> : null}
          {tab === "roles" && canViewRoleInventory ? <AdminRoleManagementPanel /> : null}

          {tab === "audit" ? (
            <div className="space-y-5">
              <h2 className="text-2xl font-semibold">审计中心</h2>
              {snapshot.auditLogs.length ? (
                <div className="space-y-3">
                  {snapshot.auditLogs.map((log) => (
                    <article key={log.id} className="rounded-2xl border border-stone-200 bg-white p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{log.action}</p>
                        <time className="text-xs text-stone-400">{log.createdAt}</time>
                      </div>
                      <p className="mt-2 text-sm text-stone-500">
                        {log.actorId} · {log.targetType} · 请求 {log.requestId}
                      </p>
                      {log.reason ? <p className="mt-1 text-sm">{log.reason}</p> : null}
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  title="暂无管理员操作"
                  detail="积分调整、配置预览/发布、角色变化、域名、支付元数据与渠道配置都会写入 append-only 审计日志；密钥和完整支付信息不会进入日志。"
                />
              )}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
