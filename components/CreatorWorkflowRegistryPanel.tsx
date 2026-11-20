"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComfyUIProviderStatus } from "@/lib/providers/comfyui/types";
import {
  COMFYUI_WORKFLOW_PACKAGE_MAX_BYTES,
  COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION,
  type ComfyUIWorkflowPackageDryResult,
  type ComfyUIWorkflowRegistryResponse,
  type ComfyUIWorkflowTemplateManagementSummary,
} from "@/lib/providers/comfyui/workflowRegistryPublic";

type RegistryState = "loading" | "ready" | "forbidden" | "unavailable" | "error";

type PendingAction =
  | { kind: "import" }
  | {
      kind: "toggle";
      template: ComfyUIWorkflowTemplateManagementSummary;
      enabled: boolean;
    }
  | {
      kind: "rollback";
      template: ComfyUIWorkflowTemplateManagementSummary;
      activeVersion: number;
    };

type SafeApiError = {
  error?: string;
  changed?: boolean;
};

function fingerprintPrefix(value: string | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

function statusMessage(state: RegistryState): string {
  if (state === "forbidden") {
    return "需要本机回环地址上的 AIstory 本地管理员会话；registry 未修改。";
  }
  if (state === "unavailable") {
    return "本地管理员控制面未启用或不可用；registry 保持原状。";
  }
  if (state === "error") {
    return "本地 workflow registry 暂时无法读取。";
  }
  return "";
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function requestState(response: Response): RegistryState {
  if (response.status === 403) return "forbidden";
  if (response.status === 503) return "unavailable";
  return "error";
}

function localInvalidPackage(): ComfyUIWorkflowPackageDryResult {
  return {
    ok: false,
    schemaVersion: COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION,
    issues: [
      {
        code: "invalid_package",
        path: "$",
        message: "Workflow package must be valid JSON.",
      },
    ],
  };
}

function localOversizePackage(): ComfyUIWorkflowPackageDryResult {
  return {
    ok: false,
    schemaVersion: COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION,
    issues: [
      {
        code: "package_too_large",
        path: "$",
        message: "Workflow package exceeds the 2 MB limit.",
      },
    ],
  };
}

export function CreatorWorkflowRegistryPanel({
  providerStatus,
}: {
  providerStatus: ComfyUIProviderStatus | null;
}) {
  const [templates, setTemplates] = useState<
    ComfyUIWorkflowTemplateManagementSummary[]
  >([]);
  const [registryState, setRegistryState] = useState<RegistryState>("loading");
  const [packageValue, setPackageValue] = useState<unknown>(null);
  const [packageName, setPackageName] = useState("");
  const [validation, setValidation] =
    useState<ComfyUIWorkflowPackageDryResult | null>(null);
  const [reason, setReason] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [fileInputRevision, setFileInputRevision] = useState(0);
  const [versionSelections, setVersionSelections] = useState<
    Record<string, number>
  >({});
  const fileSelectionRevision = useRef(0);
  const reasonInputRef = useRef<HTMLInputElement | null>(null);
  const pendingActionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);

  const loadRegistry = useCallback(async () => {
    setRegistryState("loading");
    try {
      const response = await fetch("/api/admin/comfyui/workflows", {
        cache: "no-store",
      });
      const payload = (await safeJson(response)) as
        | ComfyUIWorkflowRegistryResponse
        | SafeApiError
        | null;
      if (!response.ok) {
        setTemplates([]);
        setRegistryState(requestState(response));
        return false;
      }
      const nextTemplates =
        payload &&
        typeof payload === "object" &&
        "templates" in payload &&
        Array.isArray(payload.templates)
          ? payload.templates
          : [];
      setTemplates(nextTemplates);
      setVersionSelections(
        Object.fromEntries(
          nextTemplates.map((template) => [template.id, template.activeVersion]),
        ),
      );
      setRegistryState("ready");
      return true;
    } catch {
      setTemplates([]);
      setRegistryState("error");
      return false;
    }
  }, []);

  useEffect(() => {
    void loadRegistry();
  }, [loadRegistry]);

  useEffect(() => {
    if (pendingAction) reasonInputRef.current?.focus();
  }, [pendingAction]);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  const runtimeMessage = useMemo(() => {
    if (providerStatus === null) {
      return "ComfyUI runtime 未探测；registry 管理请求不会访问 8188。";
    }
    if (providerStatus?.state === "ready") {
      return "ComfyUI runtime 当前可用，但本页仍只管理配置，不会运行 workflow。";
    }
    if (providerStatus?.state === "disabled") {
      return "ComfyUI 当前未启用；预检、版本保存与启停仍可用，执行入口继续关闭。";
    }
    return "ComfyUI 当前离线或未配置；registry 管理不依赖 8188，也不会探测模型服务。";
  }, [providerStatus]);

  const onFileChange = useCallback(
    async (file: File | undefined) => {
      const selectionRevision = fileSelectionRevision.current + 1;
      fileSelectionRevision.current = selectionRevision;
      setPackageValue(null);
      setPackageName("");
      setValidation(null);
      setPendingAction(null);
      setReason("");
      setNotice("");
      if (!file) return;
      setPackageName(file.name);
      if (file.size <= 0 || file.size > COMFYUI_WORKFLOW_PACKAGE_MAX_BYTES) {
        setValidation(localOversizePackage());
        return;
      }
      try {
        const parsed = JSON.parse(await file.text()) as unknown;
        if (fileSelectionRevision.current !== selectionRevision) return;
        setPackageValue(parsed);
      } catch {
        if (fileSelectionRevision.current !== selectionRevision) return;
        setValidation(localInvalidPackage());
      }
    },
    [],
  );

  const dryValidate = useCallback(async () => {
    if (packageValue === null || busy) return;
    setBusy(true);
    setPendingAction(null);
    setNotice("");
    try {
      const response = await fetch("/api/admin/comfyui/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dry_validate", package: packageValue }),
      });
      const payload = (await safeJson(response)) as
        | { validation?: ComfyUIWorkflowPackageDryResult }
        | SafeApiError
        | null;
      if (response.status === 403 || response.status === 503) {
        setRegistryState(requestState(response));
        setValidation(null);
        return;
      }
      setValidation(
        payload &&
          typeof payload === "object" &&
          "validation" in payload &&
          payload.validation
          ? payload.validation
          : localInvalidPackage(),
      );
    } catch {
      setValidation(localInvalidPackage());
    } finally {
      setBusy(false);
    }
  }, [busy, packageValue]);

  const beginImport = useCallback(() => {
    if (!validation?.ok || !validation.fingerprint || packageValue === null) return;
    setReason("");
    setPendingAction({ kind: "import" });
    setNotice("");
  }, [packageValue, validation]);

  const confirmAction = useCallback(async () => {
    if (!pendingAction || busy || !reason.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const importing = pendingAction.kind === "import";
      const body = importing
        ? {
            action: "import",
            package: packageValue,
            expectedFingerprint: validation?.fingerprint,
            reason: reason.trim(),
            confirm: true,
          }
        : pendingAction.kind === "toggle"
          ? {
              templateId: pendingAction.template.id,
              enabled: pendingAction.enabled,
              reason: reason.trim(),
              confirm: true,
            }
          : {
              templateId: pendingAction.template.id,
              activeVersion: pendingAction.activeVersion,
              reason: reason.trim(),
              confirm: true,
            };
      const response = await fetch("/api/admin/comfyui/workflows", {
        method: importing ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await safeJson(response)) as SafeApiError | null;
      if (!response.ok) {
        if (response.status === 409 && payload?.error === "workflow_in_use") {
          setNotice(
            "该 workflow 有排队或执行中的生成任务；请等待任务结束或取消后重试。registry 未修改。",
          );
          return;
        }
        if (response.status === 403 || response.status === 503) {
          setRegistryState(requestState(response));
        }
        const reloaded = await loadRegistry();
        setNotice(
          payload?.error === "package_changed"
            ? "文件内容已变化，请重新预检。"
            : reloaded
              ? "操作结果未确认；已重新读取本地 registry，请按当前列表复核。"
              : "操作结果未确认，且 registry 重读失败；请停止变更并检查本地控制面。",
        );
        return;
      }
      const changed = payload?.changed !== false;
      setPendingAction(null);
      setReason("");
      if (importing) {
        setPackageValue(null);
        setPackageName("");
        setValidation(null);
        setFileInputRevision((revision) => revision + 1);
        setNotice(
          changed
            ? "Workflow 已保存到本地 registry；尚未运行模型。"
            : "相同 workflow 版本已存在，未新增版本；如需回退请切换历史 activeVersion。",
        );
      } else {
        setNotice(
          changed
            ? "本地 registry 配置已更新；尚未运行模型。"
            : "本地 registry 已是目标状态，未写入重复变更。",
        );
      }
      await loadRegistry();
    } catch {
      const reloaded = await loadRegistry();
      setNotice(
        reloaded
          ? "本地 workflow 操作结果未确认；已重新读取 registry，请按当前列表复核。"
          : "本地 workflow 操作结果未确认，且 registry 重读失败；请停止变更并检查本地控制面。",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, loadRegistry, packageValue, pendingAction, reason, validation]);

  const dryState = validation === null ? "idle" : validation.ok ? "pass" : "fail";
  const registryMessage = statusMessage(registryState);

  return (
    <div
      data-workflow-registry-panel
      className="min-w-0 max-w-full space-y-4 p-3 sm:p-4 lg:p-6"
    >
      <section className="ui-surface min-w-0 border p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="ui-primary text-xs font-semibold uppercase tracking-[0.16em]">
              AIstory 本地配置
            </p>
            <h1 className="mt-1 break-words font-serif text-2xl">
              ComfyUI Workflow 注册管理器
            </h1>
          </div>
          <span
            data-workflow-runtime-state={providerStatus?.state ?? "unknown"}
            className="ui-surface-soft w-fit border px-3 py-2 text-xs"
          >
            runtime: {providerStatus?.state ?? "unknown"}
          </span>
        </div>
        <p data-workflow-safety-notice className="ui-muted mt-3 text-sm leading-6">
          仅管理 AIstory 本地 workflow 注册表。本页不会连接 ComfyUI、不会访问
          8188，也不会运行模型。
        </p>
        <p className="mt-2 text-sm leading-6 text-amber-800">{runtimeMessage}</p>
        <p className="mt-2 text-xs leading-5 text-amber-800">
          切换 activeVersion 前须确认没有排队或运行中的生成任务；registry 与本地管理员审计不是同一事务。
        </p>
      </section>

      {registryState !== "ready" && registryState !== "loading" && (
        <div
          data-workflow-registry-state={registryState}
          role="status"
          aria-live="polite"
          className="border border-amber-700/25 bg-amber-50 p-4 text-sm leading-6 text-amber-900"
        >
          {registryMessage}
        </div>
      )}

      <section className="ui-surface min-w-0 border p-4 sm:p-5">
        <h2 className="font-serif text-xl">导入 AIstory Workflow Package v1</h2>
        <p className="ui-muted mt-2 text-sm leading-6">
          浏览器只提交 JSON 内容，不提交本地文件路径。保存前必须先通过服务端 dry validation。
        </p>
        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <label className="min-w-0 text-sm font-medium">
            本地 JSON 文件（最大 2 MB）
            <input
              key={fileInputRevision}
              data-workflow-package-input
              type="file"
              accept=".json,application/json"
              disabled={busy || registryState !== "ready"}
              onChange={(event) =>
                void onFileChange(event.currentTarget.files?.[0])
              }
              className="mt-2 block w-full min-w-0 max-w-full border p-2 text-sm file:mr-3 file:border-0 file:bg-ember-500 file:px-3 file:py-2 file:text-white"
            />
          </label>
          <button
            data-workflow-dry-validate
            type="button"
            disabled={busy || packageValue === null || registryState !== "ready"}
            onClick={() => void dryValidate()}
            className="ui-button-secondary min-h-10 border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            纯本地预检
          </button>
        </div>
        {packageName && (
          <p className="ui-muted mt-2 break-words text-xs">已选择：{packageName}</p>
        )}
        <div
          data-workflow-dry-result={dryState}
          role="status"
          aria-live="polite"
          className={`mt-4 min-w-0 border p-3 text-sm ${
            validation?.ok
              ? "border-emerald-700/25 bg-emerald-50 text-emerald-900"
              : validation
                ? "border-red-700/25 bg-red-50 text-red-900"
                : "ui-surface-soft ui-muted"
          }`}
        >
          {validation?.ok ? (
            <div className="grid min-w-0 gap-2 sm:grid-cols-3">
              <span>PASS · {validation.nodeCount} nodes</span>
              <span className="break-all">id: {validation.templateId}</span>
              <span className="break-all">
                fingerprint: {validation.fingerprint}
              </span>
            </div>
          ) : validation ? (
            <ul className="space-y-1">
              {validation.issues.map((item, index) => (
                <li key={`${item.code}:${item.path}:${index}`} className="break-words">
                  {item.code} · {item.path} · {item.message}
                </li>
              ))}
            </ul>
          ) : (
            "尚未预检。"
          )}
        </div>
        <button
          data-workflow-import
          type="button"
          disabled={busy || !validation?.ok || registryState !== "ready"}
          onClick={(event) => {
            pendingActionTriggerRef.current = event.currentTarget;
            beginImport();
          }}
          className="ui-button-primary mt-4 min-h-10 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          保存为新版本
        </button>
      </section>

      {pendingAction && (
        <section
          data-workflow-confirmation
          role="group"
          aria-labelledby="workflow-registry-confirm-title"
          className="border border-amber-700/30 bg-amber-50 p-4 text-amber-950"
        >
          <h2 id="workflow-registry-confirm-title" className="font-semibold">
            确认本地 registry 变更
          </h2>
          <p className="mt-2 break-words text-sm leading-6">
            {pendingAction.kind === "import"
              ? `确认保存 ${validation?.templateId ?? "当前 package"}。`
              : pendingAction.kind === "toggle"
                ? `确认${pendingAction.enabled ? "启用" : "停用"} ${pendingAction.template.id}。`
                : `确认将 ${pendingAction.template.id} 切换到 v${pendingAction.activeVersion}。`}
          </p>
          <label className="mt-3 block text-sm font-medium">
            变更说明（写入本地管理员审计）
            <input
              ref={reasonInputRef}
              data-workflow-reason
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              className="mt-2 w-full min-w-0 border bg-white px-3 py-2"
            />
          </label>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button
              data-workflow-confirm
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() => void confirmAction()}
              className="ui-button-primary min-h-10 px-4 py-2 text-sm disabled:opacity-50"
            >
              二次确认
            </button>
            <button
              data-workflow-cancel
              type="button"
              disabled={busy}
              onClick={() => {
                const trigger = pendingActionTriggerRef.current;
                setPendingAction(null);
                setReason("");
                queueMicrotask(() => trigger?.focus());
              }}
              className="ui-button-secondary min-h-10 border px-4 py-2 text-sm"
            >
              取消
            </button>
          </div>
        </section>
      )}

      {notice && (
        <p
          ref={noticeRef}
          data-workflow-notice
          role="status"
          aria-live="polite"
          tabIndex={-1}
          className="break-words border border-blue-700/20 bg-blue-50 p-3 text-sm leading-6 text-blue-900"
        >
          {notice}
        </p>
      )}

      <section className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-serif text-xl">已注册模板</h2>
          <button
            type="button"
            disabled={busy}
            onClick={() => void loadRegistry()}
            className="ui-button-secondary border px-3 py-2 text-xs"
          >
            刷新 registry
          </button>
        </div>
        {registryState === "loading" ? (
          <p className="ui-muted mt-4 text-sm">读取本地 registry…</p>
        ) : templates.length === 0 ? (
          <p className="ui-surface ui-muted mt-4 border p-4 text-sm">
            当前没有可显示的本地 workflow 模板。
          </p>
        ) : (
          <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <article
                key={template.id}
                data-workflow-template={template.id}
                className="ui-surface min-w-0 border p-4"
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold">{template.name}</h3>
                    <p className="ui-muted mt-1 break-all text-xs">{template.id}</p>
                  </div>
                  <span
                    data-workflow-template-enabled={String(template.enabled)}
                    className={`border px-2 py-1 text-xs ${
                      template.enabled
                        ? "border-emerald-700/25 bg-emerald-50 text-emerald-800"
                        : "border-clay-400/30 bg-cream-50 text-clay-600"
                    }`}
                  >
                    {template.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
                <dl className="ui-muted mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt>类型</dt>
                    <dd className="mt-0.5 font-medium text-clay-700">{template.modality}</dd>
                  </div>
                  <div>
                    <dt>当前版本</dt>
                    <dd className="mt-0.5 font-medium text-clay-700">v{template.activeVersion}</dd>
                  </div>
                  <div>
                    <dt>版本数</dt>
                    <dd className="mt-0.5 font-medium text-clay-700">{template.versionCount}</dd>
                  </div>
                  <div>
                    <dt>节点数</dt>
                    <dd className="mt-0.5 font-medium text-clay-700">{template.nodeCount}</dd>
                  </div>
                </dl>
                <p className="ui-muted mt-3 break-all text-xs">
                  fp {fingerprintPrefix(template.fingerprint)}…
                </p>
                <p className="ui-muted mt-1 break-words text-xs">
                  更新 {template.updatedAt}
                </p>
                <label className="mt-4 block text-xs font-medium">
                  历史版本
                  <select
                    data-workflow-version-select
                    value={versionSelections[template.id] ?? template.activeVersion}
                    onChange={(event) =>
                      setVersionSelections((current) => ({
                        ...current,
                        [template.id]: Number(event.target.value),
                      }))
                    }
                    className="mt-2 w-full min-w-0 border bg-white px-3 py-2 text-sm"
                  >
                    {template.versions.map((version) => (
                      <option key={version.version} value={version.version}>
                        v{version.version} · {version.nodeCount} nodes · {fingerprintPrefix(version.fingerprint)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button
                    data-workflow-toggle
                    type="button"
                    disabled={busy || registryState !== "ready"}
                    onClick={(event) => {
                      pendingActionTriggerRef.current = event.currentTarget;
                      setReason("");
                      setPendingAction({
                        kind: "toggle",
                        template,
                        enabled: !template.enabled,
                      });
                    }}
                    className="ui-button-secondary min-h-10 border px-3 py-2 text-xs"
                  >
                    {template.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    data-workflow-rollback
                    type="button"
                    disabled={
                      busy ||
                      registryState !== "ready" ||
                      (versionSelections[template.id] ?? template.activeVersion) ===
                        template.activeVersion
                    }
                    onClick={(event) => {
                      pendingActionTriggerRef.current = event.currentTarget;
                      setReason("");
                      setPendingAction({
                        kind: "rollback",
                        template,
                        activeVersion:
                          versionSelections[template.id] ?? template.activeVersion,
                      });
                    }}
                    className="ui-button-secondary min-h-10 border px-3 py-2 text-xs disabled:opacity-50"
                  >
                    切换所选版本
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
