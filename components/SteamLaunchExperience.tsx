"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { SteamDesktopBridge } from "@/components/SteamDesktopBridge";
import {
  decideSteamExternalTarget,
  detectSteamMediaSupport,
  STEAM_DEFAULT_EXTERNAL_TARGETS,
  STEAM_DESKTOP_OFFLINE_POLICY,
  steamReleasePlatformLabel,
  type SteamMediaSupport,
} from "@/lib/steam/contracts";
import {
  copySteamDemoReportLocally,
  createSteamDemoReportBundle,
  deliverSteamDemoReportLocally,
  downloadSteamDemoReportInBrowser,
  STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS,
  type SteamDemoReportBundle,
} from "@/lib/steam/demoReport";

type SteamView = "menu" | "about" | "settings";

const SPLASH_SEEN_KEY = "aistory:steam-powered-splash:v1";
const SPLASH_ENABLED_KEY = "aistory:steam-powered-splash-enabled:v1";

function runtimeFallback(): AIstoryDesktopRuntimeInfo {
  return {
    appVersion: process.env.NEXT_PUBLIC_AISTORY_APP_VERSION || "web-unversioned",
    platform: "steam-desktop",
    releasePlatform: "windows-x64",
    packaged: false,
    steamworks: {
      configured: false,
      appIdConfigured: false,
      capabilities: [
        {
          capability: "identity",
          available: false,
          reason: "feature-disabled",
        },
        {
          capability: "cloud",
          available: false,
          reason: "feature-disabled",
        },
        {
          capability: "input",
          available: false,
          reason: "feature-disabled",
        },
        {
          capability: "overlay",
          available: false,
          reason: "feature-disabled",
        },
        {
          capability: "softKeyboard",
          available: false,
          reason: "feature-disabled",
        },
        {
          capability: "wallet",
          available: false,
          reason: "feature-disabled",
        },
      ],
    },
  };
}

function EmptyMediaSupport(): SteamMediaSupport {
  return {
    mp4H264Aac: false,
    webmVp9Opus: false,
    preferred: "unsupported",
  };
}

function SteamExternalLinkButton({ online }: { online: boolean }) {
  const target = STEAM_DEFAULT_EXTERNAL_TARGETS[0]!;
  const decision = decideSteamExternalTarget(target.url);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState("");

  if (!decision.allowed) return null;
  const approvedTarget = decision;

  async function open() {
    setConfirming(false);
    if (!online) {
      setFeedback("当前离线，外部页面不会自动重试。");
      return;
    }
    if (!window.aistoryDesktop) {
      setFeedback("仅 AIstory 桌面壳可以打开受控外部链接。");
      return;
    }
    const result = await window.aistoryDesktop.openExternal(
      approvedTarget.url,
    );
    setFeedback(
      result.status === "opened"
        ? `已在系统浏览器打开 ${approvedTarget.domain}`
        : "外部链接当前不可用。",
    );
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => {
          if (!online) {
            setFeedback("当前离线，外部页面不可用；本地剧情仍可继续。");
            return;
          }
          setConfirming(true);
        }}
        aria-disabled={!online}
        className="inline-flex min-h-11 items-center justify-center rounded-full border border-blue-300/55 px-5 text-sm font-semibold text-blue-100 transition hover:bg-blue-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 aria-disabled:cursor-not-allowed aria-disabled:opacity-55"
      >
        访问 AIstory 项目主页
      </button>
      {feedback && (
        <p className="mt-2 text-xs text-slate-300" role="status">
          {feedback}
        </p>
      )}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="steam-external-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-blue-300/30 bg-slate-950 p-6 shadow-2xl">
            <h2
              id="steam-external-title"
              className="font-serif text-xl text-white"
            >
              在系统浏览器打开外部页面？
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              目标域名：
              <strong className="ml-1 text-blue-200">
                {approvedTarget.domain}
              </strong>
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              只有你主动确认后才会离开游戏；访问外部页面不会获得积分、道具或剧情权益。
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="min-h-11 rounded-full border border-white/20 px-5 text-sm text-white"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void open()}
                className="min-h-11 rounded-full bg-blue-500 px-5 text-sm font-semibold text-white hover:bg-blue-400"
              >
                打开 {approvedTarget.domain}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SteamLaunchExperience({
  locale,
  homeHref,
  storiesHref,
  playHref,
}: {
  locale: string;
  homeHref: string;
  storiesHref: string;
  playHref: string;
}) {
  const searchParams = useSearchParams();
  const hasSearchParams = searchParams !== null;
  const requestedView = searchParams?.get("view");
  const initialView: SteamView =
    requestedView === "about" || requestedView === "settings"
      ? requestedView
      : "menu";
  const [view, setView] = useState<SteamView>(initialView);
  const [showSplash, setShowSplash] = useState(false);
  const [splashEnabled, setSplashEnabled] = useState(true);
  const [runtimeInfo, setRuntimeInfo] =
    useState<AIstoryDesktopRuntimeInfo>(runtimeFallback);
  const [mediaSupport, setMediaSupport] =
    useState<SteamMediaSupport>(EmptyMediaSupport);
  const [online, setOnline] = useState(true);
  const [reportDescription, setReportDescription] = useState("");
  const [reportFeedback, setReportFeedback] = useState("");
  const [reportCopyFallback, setReportCopyFallback] = useState("");
  const [runtimeInfoReady, setRuntimeInfoReady] = useState(false);

  useEffect(() => {
    if (!hasSearchParams) return;
    setView(initialView);
    try {
      const enabled = window.localStorage.getItem(SPLASH_ENABLED_KEY) !== "0";
      setSplashEnabled(enabled);
      if (
        enabled &&
        initialView === "menu" &&
        window.sessionStorage.getItem(SPLASH_SEEN_KEY) !== "1"
      ) {
        setShowSplash(true);
        const timer = window.setTimeout(() => {
          window.sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
          setShowSplash(false);
        }, 1_600);
        return () => window.clearTimeout(timer);
      }
    } catch {
      setShowSplash(initialView === "menu");
    }
  }, [hasSearchParams, initialView]);

    const compiledVersion = process.env.NEXT_PUBLIC_AISTORY_APP_VERSION;
    const compiledReleaseId = process.env.NEXT_PUBLIC_AISTORY_STEAM_RELEASE_ID;
  useEffect(() => {
    if (window.aistoryDesktop) {
      void window.aistoryDesktop
        .getRuntimeInfo()
        .then((info) => {
          if (
            info &&
            info.packaged &&
            info.releasePlatform === "windows-x64" &&
            typeof compiledVersion === "string" &&
            info.appVersion === compiledVersion &&
            typeof compiledReleaseId === "string" &&
            /^[a-z0-9][a-z0-9._-]{0,95}$/i.test(compiledReleaseId)
          ) {
            setRuntimeInfo(info);
            setRuntimeInfoReady(true);
          }
        })
        .catch(() => setRuntimeInfoReady(false));
    } else {
      setRuntimeInfoReady(true);
    }
    const video = document.createElement("video");
    setMediaSupport(
      detectSteamMediaSupport((mime) => video.canPlayType(mime)),
    );
    setOnline(window.navigator.onLine);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [compiledReleaseId, compiledVersion]);

  const steamworksReady = useMemo(
    () => runtimeInfo.steamworks.configured,
    [runtimeInfo],
  );
  const releasePlatformLabel = steamReleasePlatformLabel(
    runtimeInfo.releasePlatform,
  );

  function dismissSplash() {
    try {
      window.sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
    } catch {
      // The splash remains safely skippable even when browser storage is off.
    }
    setShowSplash(false);
  }

  function toggleSplashPreference() {
    const next = !splashEnabled;
    try {
      window.localStorage.setItem(SPLASH_ENABLED_KEY, next ? "1" : "0");
      setSplashEnabled(next);
    } catch {
      // Keep the visible state honest when persistent browser storage is off.
    }
  }


  function currentReportBundle(): SteamDemoReportBundle {
    if (window.aistoryDesktop && !runtimeInfoReady) {
      throw new Error("desktop_runtime_info_unavailable");
    }
    const desktopRuntime = Boolean(window.aistoryDesktop);
    return createSteamDemoReportBundle({
      releaseId:
        process.env.NEXT_PUBLIC_AISTORY_STEAM_RELEASE_ID ||
        "steam-web-local-candidate",
      generatedAt: new Date().toISOString(),
      appVersion:
        runtimeInfo.appVersion ||
        process.env.NEXT_PUBLIC_AISTORY_APP_VERSION ||
        "web-unversioned",
      platform: desktopRuntime
        ? runtimeInfo.releasePlatform === "windows-x64"
          ? "windows"
          : "linux"
        : "web",
      architecture: desktopRuntime ? "x64" : "unknown",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      publicContext: { route: "steam" },
      steamworks: runtimeInfo.steamworks,
      issueDescription: reportDescription,
    });
  }

  async function writeReportToClipboard(text: string) {
    if (typeof window.navigator.clipboard?.writeText !== "function") {
      throw new Error("clipboard_unavailable");
    }
    await window.navigator.clipboard.writeText(text);
  }

  function reportBuildFailed() {
    setReportFeedback(
      `\u95ee\u9898\u63cf\u8ff0\u9700\u4e3a 1\u2013${STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS} \u4e2a\u5b57\u7b26\u7684\u7eaf\u6587\u672c\uff0c\u4e14\u4e0d\u80fd\u5305\u542b\u8d26\u53f7\u3001\u5bc6\u94a5\u3001\u8def\u5f84\u6216\u5185\u90e8\u4efb\u52a1\u4fe1\u606f\u3002`,
    );
  }

  async function downloadReport() {
    let bundle: SteamDemoReportBundle;
    try {
      bundle = currentReportBundle();
    } catch {
      reportBuildFailed();
      return;
    }
    setReportCopyFallback("");
    const result = await deliverSteamDemoReportLocally(bundle, {
      download: (value) => downloadSteamDemoReportInBrowser(value),
      copy: writeReportToClipboard,
    });
    setReportFeedback(
      result.status === "download-started"
        ? "\u5df2\u53d1\u8d77\u672c\u673a JSON \u4e0b\u8f7d\uff1b\u5e94\u7528\u4e0d\u4f1a\u81ea\u52a8\u4e0a\u4f20\uff0c\u8bf7\u7531\u4f60\u81ea\u884c\u53d1\u9001\u3002"
        : result.status === "copied"
          ? "\u6d4f\u89c8\u5668\u672a\u80fd\u53d1\u8d77\u4e0b\u8f7d\uff1b\u540c\u4e00\u4efd\u8131\u654f JSON \u5df2\u590d\u5236\uff0c\u8bf7\u7531\u4f60\u81ea\u884c\u53d1\u9001\u3002"
          : "\u6d4f\u89c8\u5668\u963b\u6b62\u4e86\u4e0b\u8f7d\u4e0e\u81ea\u52a8\u590d\u5236\u3002\u540c\u4e00\u4efd JSON \u5df2\u5728\u4e0b\u65b9\u663e\u793a\uff0c\u53ef\u624b\u52a8\u5168\u9009\u590d\u5236\uff1b\u62a5\u544a\u672a\u4e0a\u4f20\u3002",
    );
    if (result.status === "unavailable") setReportCopyFallback(bundle.json);
  }

  async function copyReport() {
    let bundle: SteamDemoReportBundle;
    try {
      bundle = currentReportBundle();
    } catch {
      reportBuildFailed();
      return;
    }
    setReportCopyFallback("");
    const result = await copySteamDemoReportLocally(
      bundle,
      writeReportToClipboard,
    );
    setReportFeedback(
      result.status === "copied"
        ? "\u8131\u654f JSON \u5df2\u590d\u5236\uff1b\u5e94\u7528\u4e0d\u4f1a\u81ea\u52a8\u4e0a\u4f20\uff0c\u8bf7\u7531\u4f60\u81ea\u884c\u53d1\u9001\u3002"
        : "\u5f53\u524d\u73af\u5883\u4e0d\u5141\u8bb8\u81ea\u52a8\u590d\u5236\u3002\u540c\u4e00\u4efd JSON \u5df2\u5728\u4e0b\u65b9\u663e\u793a\uff0c\u53ef\u624b\u52a8\u5168\u9009\u590d\u5236\uff1b\u62a5\u544a\u672a\u4e0a\u4f20\u3002",
    );
    if (result.status === "unavailable") setReportCopyFallback(bundle.json);
  }
  return (
    <main
      data-steam-shell
      data-steam-release-platform={runtimeInfo.releasePlatform}
      className="min-h-screen overflow-x-hidden bg-[#070b18] text-white [&_a]:focus-visible:outline [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2 [&_a]:focus-visible:outline-blue-300 [&_button]:focus-visible:outline [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-blue-300"
    >
      <SteamDesktopBridge enabled />
      {showSplash && (
        <button
          type="button"
          onClick={dismissSplash}
          className="fixed inset-0 z-50 flex w-full flex-col items-center justify-center bg-[#050814] px-6 text-center"
          aria-label="跳过启动品牌画面"
        >
          <span className="text-xs uppercase tracking-[0.34em] text-blue-300">
            Powered by
          </span>
          <span className="mt-3 font-serif text-4xl tracking-tight sm:text-5xl">
            AI<span className="text-blue-400">story</span>
          </span>
          <span className="mt-4 text-sm text-slate-300">
            互动叙事引擎
          </span>
          <span className="absolute bottom-8 text-xs text-slate-500">
            点击、按确认键或等待片刻即可跳过
          </span>
        </button>
      )}

      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-6 sm:px-8 lg:px-12">
        <header className="flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setView("menu")}
            className="font-serif text-2xl tracking-tight text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300"
          >
            AI<span className="text-blue-400">story</span>
          </button>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="rounded-full border border-white/10 px-3 py-1.5">
              {releasePlatformLabel}
            </span>
            <span className="hidden rounded-full border border-white/10 px-3 py-1.5 sm:inline-flex">
              Steam Deck · 1280×800 候选
            </span>
          </div>
        </header>

        <section className="flex flex-1 items-center py-8">
          {view === "menu" && (
            <div className="grid w-full gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-3xl border border-blue-300/20 bg-gradient-to-br from-blue-500/15 to-slate-950 p-6 shadow-2xl sm:p-10">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-blue-300">
                  本地互动影游
                </p>
                <h1 className="mt-4 max-w-2xl font-serif text-4xl leading-tight sm:text-5xl">
                  一个选择，改写下一幕。
                </h1>
                <p className="mt-4 max-w-xl text-sm leading-7 text-slate-300 sm:text-base">
                  已发布作者锁定内容、字幕、分支和浏览器本机存档可离线运行。外部网站、Steamworks
                  与购买都不是继续游玩的前置条件。
                </p>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <Link
                    href={playHref}
                    className="inline-flex min-h-12 items-center justify-center rounded-full bg-blue-500 px-7 text-sm font-semibold text-white transition hover:bg-blue-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300"
                  >
                    开始本地案例
                  </Link>
                  <Link
                    href={storiesHref}
                    className="inline-flex min-h-12 items-center justify-center rounded-full border border-blue-300/45 px-7 text-sm font-semibold text-blue-100 transition hover:bg-blue-400/10"
                  >
                    我的本机进度
                  </Link>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <button
                  type="button"
                  data-steam-open-settings
                  onClick={() => setView("settings")}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-left transition hover:border-blue-300/40 hover:bg-blue-400/[0.06]"
                >
                  <span className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    设置
                  </span>
                  <strong className="mt-2 block text-lg">
                    全屏、输入与媒体检查
                  </strong>
                  <span className="mt-2 block text-xs leading-5 text-slate-400">
                    1280×800 / 16:10、键鼠、触控与基础手柄导航。
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setView("about")}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-left transition hover:border-blue-300/40 hover:bg-blue-400/[0.06]"
                >
                  <span className="text-xs uppercase tracking-[0.18em] text-slate-400">
                    关于
                  </span>
                  <strong className="mt-2 block text-lg">
                    AIstory 创作引擎
                  </strong>
                  <span className="mt-2 block text-xs leading-5 text-slate-400">
                    品牌、版权与受控外部入口。
                  </span>
                </button>
              </div>
            </div>
          )}

          {view === "about" && (
            <div className="mx-auto w-full max-w-3xl rounded-3xl border border-blue-300/20 bg-slate-950/75 p-6 shadow-2xl sm:p-10">
              <p className="text-xs uppercase tracking-[0.24em] text-blue-300">
                Powered by AIstory
              </p>
              <h1 className="mt-4 font-serif text-3xl sm:text-4xl">
                AIstory 互动叙事与创作引擎
              </h1>
              <div className="mt-6 space-y-4 text-sm leading-7 text-slate-300">
                <p>
                  AIstory 用统一的故事状态、互动分支、图片、视频、字幕和角色连续性运行时，承载可回溯的互动影游。
                </p>
                <p>
                  Steam 版本的品牌介绍不会打断剧情，不要求访问外部网站，也不会通过点击、注册或分享发放积分、道具或剧情权益。正常剧情画面不加平台宣传水印。
                </p>
                <p>
                  当前 P1 提供 Windows x64 与 Linux x64 目录包候选；Steam Deck 通过 Proton
                  兼容路径继续保留。原生 Linux 与真实 Steam Deck
                  仍待机械验收；Steamworks、Steam Cloud、Overlay、软键盘和 Steam Wallet
                  尚未接入真实 AppID。
                </p>
              </div>
              <SteamExternalLinkButton online={online} />
              <p className="mt-8 text-xs leading-5 text-slate-500">
                © 2026 AIstory。应用代码许可为 AGPL-3.0-only；第三方代码、模型、素材和作品内容按各自许可与权利条件适用。
              </p>
              <button
                type="button"
                onClick={() => setView("menu")}
                className="mt-6 min-h-11 rounded-full border border-white/20 px-5 text-sm text-white"
              >
                返回主菜单
              </button>
            </div>
          )}

          {view === "settings" && (
            <div className="mx-auto w-full max-w-3xl rounded-3xl border border-blue-300/20 bg-slate-950/75 p-6 shadow-2xl sm:p-10">
              <h1 className="font-serif text-3xl">桌面运行检查</h1>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 p-4">
                  <p className="text-xs text-slate-400">视频策略</p>
                  <p className="mt-2 text-sm leading-6">
                    {mediaSupport.preferred === "webm-vp9-opus"
                      ? "优先 WebM VP9/Opus；MP4 H.264/AAC 作为兼容变体。"
                      : mediaSupport.preferred === "mp4-h264-aac"
                        ? "当前仅确认 MP4 H.264/AAC；发布前需补 Proton 实机回归。"
                        : "当前浏览器未确认支持首发视频编码。"}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 p-4">
                  <p className="text-xs text-slate-400">Steamworks</p>
                  <p className="mt-2 text-sm leading-6">
                    {steamworksReady
                      ? "适配器已配置。"
                      : "未接入真实 AppID / SDK，SteamID、Cloud、Input、Overlay、软键盘与购买全部关闭。"}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 p-4">
                  <p className="text-xs text-slate-400">网络与离线</p>
                  <p className="mt-2 text-sm leading-6" aria-live="polite">
                    {online
                      ? "当前可访问网络；桌面包仍默认关闭平台生成、短信、正式积分与远程生成。"
                      : "当前离线。已发布作者内容、字幕、分支和本机存档仍可使用；外链不会自动重试。"}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 p-4">
                  <p className="text-xs text-slate-400">Steam Deck 输入</p>
                  <p className="mt-2 text-sm leading-6">
                    1280×800 / 1280×720、基础 Gamepad、触控与键鼠回退已定义。Steam
                    软键盘在真实 Input SDK 接入前保持不可用。
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 p-4 sm:col-span-2">
                  <p className="text-xs text-slate-400">购买与积分</p>
                  <p className="mt-2 text-sm leading-6">
                    Steam Wallet 尚未接通。本构建不提供站外购买或绕过 Steam
                    支付的入口；离线作者内容不依赖购买即可游玩。
                  </p>
                  <p className="mt-2 text-xs leading-5 text-slate-400">
                    安装包不包含 BYOK 或托管密钥：
                    {STEAM_DESKTOP_OFFLINE_POLICY.hostedCredentialsBundled ||
                    STEAM_DESKTOP_OFFLINE_POLICY.deviceCredentialsBundled
                      ? "配置异常"
                      : "已关闭"}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 p-4 sm:col-span-2">
                  <p className="text-xs text-slate-400">启动偏好</p>
                  <p className="mt-2 text-sm leading-6">
                    启动品牌画面：{splashEnabled ? "已开启" : "已关闭"}。此非敏感偏好仅保存在 Electron userData，不会读取或迁移浏览器 BYOK。
                  </p>
                  <button
                    type="button"
                    data-steam-toggle-splash
                    onClick={toggleSplashPreference}
                    className="mt-3 min-h-11 rounded-full border border-blue-300/45 px-5 text-sm font-semibold text-blue-100 transition hover:bg-blue-400/10"
                  >
                    {splashEnabled
                      ? "下次启动不显示品牌画面"
                      : "下次启动显示品牌画面"}
                  </button>
                </div>
                <div
                  data-steam-report-panel
                  className="min-w-0 rounded-2xl border border-blue-300/30 bg-blue-400/[0.04] p-4 sm:col-span-2"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-300">
                    {"\u672c\u5730\u6d4b\u8bd5\u534f\u52a9"}
                  </p>
                  <h2 className="mt-2 text-lg font-semibold text-white">
                    {"\u5bfc\u51fa\u6d4b\u8bd5\u62a5\u544a"}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    {"\u62a5\u544a\u4e0d\u4f1a\u81ea\u52a8\u8bfb\u53d6\u8d26\u53f7\u3001\u624b\u673a\u53f7\u3001\u5b58\u6863\u6b63\u6587\u3001\u5bc6\u94a5\u3001\u63d0\u793a\u8bcd\u3001workflow\u3001\u4efb\u52a1\u8f7d\u8377\u3001\u672c\u5730\u8def\u5f84\u3001\u65e5\u5fd7\u6216\u9519\u8bef\u5806\u6808\u3002\u95ee\u9898\u63cf\u8ff0\u7531\u4f60\u4e3b\u52a8\u586b\u5199\uff1b\u8bf7\u52ff\u7c98\u8d34\u654f\u611f\u5185\u5bb9\u3002\u62a5\u544a\u53ea\u4fdd\u5b58\u5230\u672c\u673a\uff0c\u7531\u4f60\u81ea\u884c\u53d1\u9001\u3002"}
                  </p>
                  <label
                    htmlFor="steam-demo-report-description"
                    className="mt-4 block text-sm font-medium text-slate-200"
                  >
                    {"\u95ee\u9898\u63cf\u8ff0\uff08\u5fc5\u586b\uff0c\u6700\u591a "}
                    {STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS}
                    {" \u5b57\uff09"}
                  </label>
                  <textarea
                    id="steam-demo-report-description"
                    data-steam-report-description
                    value={reportDescription}
                    maxLength={STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS}
                    onChange={(event) => {
                      setReportDescription(event.target.value);
                      setReportFeedback("");
                    }}
                    rows={4}
                    placeholder={"\u4f8b\u5982\uff1a\u7b2c\u4e8c\u7ae0\u9009\u62e9\u540e\uff0c\u5b57\u5e55\u51fa\u73b0\u5f97\u6bd4\u58f0\u97f3\u6162\u3002\u8bf7\u52ff\u7c98\u8d34\u8d26\u53f7\u3001\u5bc6\u94a5\u6216\u672c\u5730\u8def\u5f84\u3002"}
                    className="mt-2 min-h-28 w-full min-w-0 resize-y rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-sm leading-6 text-white placeholder:text-slate-500 focus:border-blue-300 focus:outline-none"
                  />
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      data-steam-report-download
                      disabled={!runtimeInfoReady}
                      onClick={() => void downloadReport()}
                      className="min-h-11 rounded-full bg-blue-500 px-5 text-sm font-semibold text-white transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {"\u4e0b\u8f7d\u8131\u654f JSON"}
                    </button>
                    <button
                      type="button"
                      data-steam-report-copy
                      onClick={() => void copyReport()}
                      disabled={!runtimeInfoReady}
                      className="min-h-11 rounded-full border border-blue-300/45 px-5 text-sm font-semibold text-blue-100 transition hover:bg-blue-400/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {"\u590d\u5236\u540c\u4e00\u4efd\u8131\u654f\u5185\u5bb9"}
                    </button>
                  </div>
                  {!runtimeInfoReady && <p className="mt-3 text-xs leading-5 text-amber-200" role="status">{"\u6b63\u5728\u8bfb\u53d6\u516c\u5f00\u7248\u672c\u4fe1\u606f\uff1b\u8bfb\u53d6\u5931\u8d25\u65f6\u62a5\u544a\u5bfc\u51fa\u4fdd\u6301\u5173\u95ed\u3002"}</p>}
                  {reportFeedback && (
                    <p
                      data-steam-report-feedback
                      className="mt-3 break-words text-xs leading-5 text-slate-300"
                      role="status"
                      aria-live="polite"
                    >
                      {reportFeedback}
                    </p>
                  )}
                  {reportCopyFallback && (
                    <textarea
                      data-steam-report-copy-fallback
                      readOnly
                      value={reportCopyFallback}
                      aria-label={"\u53ef\u624b\u52a8\u590d\u5236\u7684\u6d4b\u8bd5\u62a5\u544a JSON"}
                      onFocus={(event) => event.currentTarget.select()}
                      className="mt-3 max-h-48 w-full min-w-0 resize-y rounded-xl border border-amber-300/30 bg-black/40 px-3 py-2 font-mono text-xs leading-5 text-slate-200"
                    />
                  )}
                </div>
              </div>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => void window.aistoryDesktop?.toggleFullscreen()}
                  className="min-h-11 rounded-full bg-blue-500 px-5 text-sm font-semibold text-white hover:bg-blue-400"
                >
                  切换全屏
                </button>
                <button
                  type="button"
                  onClick={() => setView("menu")}
                  className="min-h-11 rounded-full border border-white/20 px-5 text-sm text-white"
                >
                  返回主菜单
                </button>
              </div>
            </div>
          )}
        </section>

        <footer className="flex flex-col gap-2 border-t border-white/10 pt-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => setView("about")}
            className="text-left text-blue-300 transition hover:text-blue-200"
          >
            Powered by AIstory · AIstory 创作引擎
          </button>
          <Link href={homeHref} className="transition hover:text-slate-300">
            返回 Web 首页
          </Link>
          <span>{locale}</span>
        </footer>
      </div>
    </main>
  );
}
