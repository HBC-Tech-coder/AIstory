import type { BranchPrefetchDepth } from "@infiplot/types";

export type UsageCapability = "text" | "image" | "vision" | "tts" | "video";

export type UsageAction =
  | "start_custom"
  | "continue_choice"
  | "apply_next_style"
  | "redraw_current"
  | "rewrite_current";

export type UsageSource = "user_byok" | "platform_managed";

export type UsageDisclosure = {
  action: UsageAction;
  capabilities: Array<{
    capability: UsageCapability;
    source: UsageSource;
  }>;
  prefetchDepth: BranchPrefetchDepth;
  speculativeCapabilities: UsageCapability[];
  responsibility: "user_provider" | "platform_internal" | "mixed" | "none";
};

export type UsageDisclosureInput = {
  action: UsageAction;
  audioEnabled?: boolean;
  prefetchDepth?: BranchPrefetchDepth;
  byokReady?: Partial<Record<UsageCapability, boolean>>;
};

const ACTION_CAPABILITIES: Record<UsageAction, UsageCapability[]> = {
  start_custom: ["text", "image"],
  continue_choice: ["text", "image"],
  apply_next_style: [],
  redraw_current: ["image"],
  rewrite_current: ["text"],
};

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function buildUsageDisclosure(
  input: UsageDisclosureInput,
): UsageDisclosure {
  const prefetchDepth = input.prefetchDepth ?? 0;
  const immediate = [...ACTION_CAPABILITIES[input.action]];
  if (
    input.audioEnabled &&
    (input.action === "start_custom" || input.action === "continue_choice")
  ) {
    immediate.push("tts");
  }
  const speculativeCapabilities: UsageCapability[] =
    prefetchDepth > 0 &&
    (input.action === "start_custom" ||
      input.action === "continue_choice" ||
      input.action === "apply_next_style")
      ? ["text", "image"]
      : [];
  const used = unique([...immediate, ...speculativeCapabilities]);
  const capabilities = used.map((capability) => ({
    capability,
    source: input.byokReady?.[capability]
      ? ("user_byok" as const)
      : ("platform_managed" as const),
  }));
  const sources = new Set(capabilities.map((item) => item.source));
  const responsibility =
    capabilities.length === 0
      ? "none"
      : sources.size > 1
        ? "mixed"
        : sources.has("user_byok")
          ? "user_provider"
          : "platform_internal";

  return {
    action: input.action,
    capabilities,
    prefetchDepth,
    speculativeCapabilities,
    responsibility,
  };
}

type SupportedLocale = "zh-CN" | "en" | "ja";

function supportedLocale(locale: string): SupportedLocale {
  return locale === "en" || locale === "ja" ? locale : "zh-CN";
}

const COPY: Record<
  SupportedLocale,
  {
    title: string;
    noImmediateCall: string;
    capabilities: Record<UsageCapability, string>;
    responsibility: Record<UsageDisclosure["responsibility"], string>;
    prefetchOff: string;
    prefetchOne: string;
  }
> = {
  "zh-CN": {
    title: "本次调用",
    noImmediateCall: "保存设置本身不调用模型。",
    capabilities: {
      text: "文字",
      image: "图片",
      vision: "识图",
      tts: "配音",
      video: "视频",
    },
    responsibility: {
      user_provider: "费用由你的服务商账户承担，不扣平台积分。",
      platform_internal:
        "当前走平台受控测试；正式积分扣费尚未开放，不展示虚构价格。",
      mixed:
        "已配置能力由你的服务商账户承担，其余走平台受控测试；正式积分扣费尚未开放。",
      none: "",
    },
    prefetchOff: "预生成 0 层：不会提前请求下一分支。",
    prefetchOne:
      "预生成 1 层：只提前生成下一层文字与图片，可能产生服务商费用。",
  },
  en: {
    title: "This action",
    noImmediateCall: "Saving this setting does not call a model.",
    capabilities: {
      text: "text",
      image: "image",
      vision: "vision",
      tts: "voice",
      video: "video",
    },
    responsibility: {
      user_provider:
        "Charges go to your provider account; no platform credits are deducted.",
      platform_internal:
        "This uses controlled platform testing. Public credit billing is not enabled, so no invented price is shown.",
      mixed:
        "Configured capabilities use your provider account; the rest use controlled platform testing. Public credit billing is not enabled.",
      none: "",
    },
    prefetchOff: "Prefetch 0: no next-branch request is made in advance.",
    prefetchOne:
      "Prefetch 1: only the next text and image layer is prepared and may incur provider charges.",
  },
  ja: {
    title: "今回の呼び出し",
    noImmediateCall: "設定の保存だけではモデルを呼び出しません。",
    capabilities: {
      text: "テキスト",
      image: "画像",
      vision: "画像認識",
      tts: "音声",
      video: "動画",
    },
    responsibility: {
      user_provider:
        "料金はご自身のプロバイダーアカウントに請求され、プラットフォームポイントは消費しません。",
      platform_internal:
        "現在は管理されたプラットフォームテストです。正式なポイント課金は未公開のため、架空の価格は表示しません。",
      mixed:
        "設定済みの機能はご自身のプロバイダー、それ以外は管理テストを利用します。正式なポイント課金は未公開です。",
      none: "",
    },
    prefetchOff: "事前生成 0：次の分岐を先にリクエストしません。",
    prefetchOne:
      "事前生成 1：次のテキストと画像だけを先に生成し、プロバイダー料金が発生する場合があります。",
  },
};

export function formatUsageDisclosure(
  disclosure: UsageDisclosure,
  locale: string,
): string {
  const copy = COPY[supportedLocale(locale)];
  const capabilityText = disclosure.capabilities
    .map((item) => copy.capabilities[item.capability])
    .join(" + ");
  const immediate =
    capabilityText.length > 0
      ? `${copy.title}：${capabilityText}。`
      : copy.noImmediateCall;
  const responsibility = copy.responsibility[disclosure.responsibility];
  const prefetch =
    disclosure.action === "start_custom" ||
    disclosure.action === "continue_choice" ||
    disclosure.action === "apply_next_style"
      ? disclosure.prefetchDepth === 0
        ? copy.prefetchOff
        : copy.prefetchOne
      : "";
  return [immediate, responsibility, prefetch].filter(Boolean).join(" ");
}

