"use client";

import { useEffect, useRef, useState } from "react";

import type {
  GenerationReadiness,
  GenerationReadinessReason,
} from "@/lib/billing/generationReadiness";
// Exact import used by the home page, so the notice follows the user locale.
import { useI18n } from "@/lib/i18n/client";

const ENDPOINT = "/api/account/generation-readiness";
const REQUEST_TIMEOUT_MS = 8_000;
/**
 * Optional account-change signal. Auth/login/logout code (or the later home
 * integration) may dispatch this event; changing `refreshKey` also refreshes.
 */
const ACCOUNT_CHANGED_EVENT = "aistory:account-changed";

type UnavailableReason = Exclude<GenerationReadinessReason, "ready">;

type Copy = {
  loading: string;
  error: string;
  ready: (credits: number) => string;
} & Record<UnavailableReason, string>;

const UNAVAILABLE_REASONS: readonly UnavailableReason[] = [
  "billing_disabled",
  "phone_verification_required",
  "database_gate_unavailable",
  "runtime_config_unavailable",
  "account_inactive",
  "pricing_unavailable",
  "service_unavailable",
];

const COPY: Record<"zh-CN" | "en" | "ja", Copy> = {
  "zh-CN": {
    loading: "正在检查平台积分生成状态…",
    error: "无法连接平台状态服务，请稍后刷新页面重试。",
    ready: (credits) =>
      `平台积分生成已就绪 · 开始新故事预计 ${credits.toLocaleString("zh-CN")} 积分`,
    billing_disabled:
      "平台积分生成暂未开启。你的积分仍会保留；已发布的故事仍可继续游玩，也可继续使用自己的 API Key（BYOK）。",
    phone_verification_required:
      "平台积分生成需要手机号登录。请先完成手机号验证码登录；已发布的故事和 BYOK 仍可正常使用。",
    database_gate_unavailable:
      "平台计费服务暂时不可用，请稍后再试；已发布的故事仍可继续游玩。",
    runtime_config_unavailable:
      "平台生成配置暂时不可用，请稍后再试。",
    account_inactive:
      "当前账户状态暂时无法用于平台积分生成，请稍后再试。",
    pricing_unavailable:
      "平台定价尚未配置，暂时无法使用积分生成；未发起任何模型调用。已发布的故事仍可继续游玩。",
    service_unavailable:
      "平台生成状态暂时无法确认，请稍后再试。",
  },
  en: {
    loading: "Checking platform credit generation status…",
    error: "Unable to reach the platform status service. Please refresh later.",
    ready: (credits) =>
      `Platform credit generation is ready · about ${credits.toLocaleString("en-US")} credits to start a story`,
    billing_disabled:
      "Platform credit generation is not enabled yet. Your credits are retained; published stories still play, and you can keep using your own API key (BYOK).",
    phone_verification_required:
      "Platform credit generation requires phone sign-in. Verify your phone first; published stories and BYOK still work.",
    database_gate_unavailable:
      "Platform billing is temporarily unavailable. Please try again later; published stories still play.",
    runtime_config_unavailable:
      "Platform generation configuration is temporarily unavailable. Please try again later.",
    account_inactive:
      "This account cannot use platform credit generation right now. Please try again later.",
    pricing_unavailable:
      "Platform pricing is not configured yet, so credit generation is unavailable. No model call was made. Published stories still play.",
    service_unavailable:
      "Platform generation status cannot be confirmed right now. Please try again later.",
  },
  ja: {
    loading: "プラットフォーム生成の状態を確認しています…",
    error:
      "プラットフォーム状態サービスに接続できません。後でページを再読み込みしてください。",
    ready: (credits) =>
      `プラットフォームのクレジット生成は準備完了です · 新規ストーリー開始の目安 ${credits.toLocaleString("ja-JP")} クレジット`,
    billing_disabled:
      "プラットフォームのクレジット生成はまだ有効になっていません。クレジットは保持され、公開済みのストーリーは引き続き遊べます。ご自身の API キー（BYOK）も引き続き利用できます。",
    phone_verification_required:
      "プラットフォームのクレジット生成には電話番号でのログインが必要です。先に認証を完了してください。公開済みストーリーと BYOK は引き続き利用できます。",
    database_gate_unavailable:
      "プラットフォームの課金サービスが一時的に利用できません。後でもう一度お試しください。公開済みストーリーは引き続き遊べます。",
    runtime_config_unavailable:
      "プラットフォーム生成の設定が一時的に利用できません。後でもう一度お試しください。",
    account_inactive:
      "現在のアカウントではプラットフォームのクレジット生成を利用できません。後でもう一度お試しください。",
    pricing_unavailable:
      "プラットフォームの価格表が未設定のため、クレジット生成は利用できません。モデル呼び出しは行っていません。公開済みストーリーは引き続き遊べます。",
    service_unavailable:
      "プラットフォーム生成の状態を確認できません。後でもう一度お試しください。",
  },
};

function copyForLocale(locale: string): Copy {
  if (locale.startsWith("en")) return COPY.en;
  if (locale.startsWith("ja")) return COPY.ja;
  return COPY["zh-CN"];
}

function isUnavailableReason(value: unknown): value is UnavailableReason {
  return typeof value === "string"
    && (UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

function parseReadiness(payload: unknown): GenerationReadiness | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.scope !== "story.start") return null;
  if (typeof record.available !== "boolean") return null;
  if (typeof record.message !== "string") return null;

  const estimatedCredits = record.estimatedCredits;
  if (
    estimatedCredits !== undefined
    && (
      typeof estimatedCredits !== "number"
      || !Number.isSafeInteger(estimatedCredits)
      || estimatedCredits < 0
    )
  ) {
    return null;
  }

  if (record.reason === "ready") {
    if (record.available !== true) return null;
    return {
      scope: "story.start",
      available: true,
      reason: "ready",
      ...(estimatedCredits !== undefined ? { estimatedCredits } : {}),
      message: record.message,
    };
  }

  const reason = record.reason;
  if (!isUnavailableReason(reason) || record.available !== false) {
    return null;
  }
  return {
    scope: "story.start",
    available: false,
    reason,
    message: record.message,
  };
}

type ViewState =
  | { status: "loading" }
  | { status: "ready"; estimatedCredits?: number }
  | { status: "unavailable"; reason: UnavailableReason }
  | { status: "error" };

function toViewState(readiness: GenerationReadiness): ViewState {
  if (readiness.reason === "ready" && readiness.available) {
    return { status: "ready", estimatedCredits: readiness.estimatedCredits };
  }
  if (readiness.reason !== "ready" && !readiness.available) {
    return { status: "unavailable", reason: readiness.reason };
  }
  return { status: "error" };
}

export function PlatformGenerationNotice({
  className,
  refreshKey,
}: {
  className?: string;
  refreshKey?: string | number | boolean;
}) {
  const { locale } = useI18n();
  const copy = copyForLocale(locale);
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const requestSeq = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    let disposed = false;

    const load = () => {
      // Increment before aborting so the aborted request's catch handler sees a
      // stale sequence and cannot overwrite this request's state.
      const seq = requestSeq.current + 1;
      requestSeq.current = seq;
      activeController.current?.abort();

      const controller = new AbortController();
      activeController.current = controller;
      const timeout = window.setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      setState({ status: "loading" });

      void fetch(ENDPOINT, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (response) => {
          // A non-2xx response is not a trustworthy readiness projection, even
          // if its body happens to parse into a valid shape (for example a 503
          // with a crafted "ready" payload). Reject it as a transport failure.
          if (!response.ok) return null;
          const payload: unknown = await response.json().catch(() => null);
          return parseReadiness(payload);
        })
        .then((readiness) => {
          if (disposed || seq !== requestSeq.current) return;
          if (!readiness) {
            setState({ status: "error" });
            return;
          }
          setState(toViewState(readiness));
        })
        .catch(() => {
          if (disposed || seq !== requestSeq.current) return;
          // Aborts caused by unmount or a newer request are ignored above.
          // Timeouts and transport failures are reported truthfully.
          setState({ status: "error" });
        })
        .finally(() => {
          window.clearTimeout(timeout);
        });
    };

    load();

    const onAccountChanged = () => load();

    // Account-change is the explicit signal; no broad storage-key listener,
    // which used to refresh on unrelated writes.
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    return () => {
      disposed = true;
      activeController.current?.abort();
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
    };
  }, [refreshKey]);

  if (state.status === "ready") {
    // Ready without a quoted cost: stay quiet instead of inventing a price.
    if (typeof state.estimatedCredits !== "number") return null;
    return (
      <p
        role="status"
        aria-live="polite"
        data-platform-generation-notice="ready"
        className={["font-sans text-xs leading-relaxed text-clay-500", className]
          .filter(Boolean)
          .join(" ")}
      >
        {copy.ready(state.estimatedCredits)}
      </p>
    );
  }

  if (state.status === "loading") {
    return (
      <p
        role="status"
        aria-live="polite"
        data-platform-generation-notice="loading"
        className={["font-sans text-xs leading-relaxed text-clay-500", className]
          .filter(Boolean)
          .join(" ")}
      >
        {copy.loading}
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p
        role="status"
        aria-live="polite"
        data-platform-generation-notice="error"
        className={[
          "flex items-start gap-2 rounded-sm border border-clay-900/15 bg-cream-100/70 px-3 py-2 font-sans text-xs leading-relaxed text-clay-600",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <i
          className="fa-solid fa-triangle-exclamation mt-0.5 text-ember-500"
          aria-hidden="true"
        />
        <span>{copy.error}</span>
      </p>
    );
  }

  return (
    <p
      role="status"
      aria-live="polite"
      data-platform-generation-notice="unavailable"
      className={[
        "flex items-start gap-2 rounded-sm border border-ember-500/25 bg-cream-100/70 px-3 py-2 font-sans text-xs leading-relaxed text-clay-700",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <i
        className="fa-solid fa-circle-info mt-0.5 text-ember-500"
        aria-hidden="true"
      />
      <span>{copy[state.reason]}</span>
    </p>
  );
}

export default PlatformGenerationNotice;
