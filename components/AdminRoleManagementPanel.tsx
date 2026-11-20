"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminRole } from "@/lib/admin/types";

type RoleInventoryEntry = {
  role: AdminRole;
  displayName?: string;
  createdAt: string;
};

type RoleInventoryResponse = {
  generatedAt?: string;
  roles?: RoleInventoryEntry[];
};

const ROLE_LABELS: Record<string, string> = {
  super_admin: "超级管理员",
  ops: "运维",
  finance: "财务",
  moderator: "内容审核",
  support: "客服支持",
  analyst: "数据分析",
};

const UNAVAILABLE_MESSAGE = "管理员角色数据暂时不可用。";

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function formatCreatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", { hour12: false });
}

export function AdminRoleManagementPanel() {
  const [entries, setEntries] = useState<RoleInventoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/roles", {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) {
        setEntries(null);
        setError("当前会话无权查看管理员角色清单。");
        return;
      }
      if (!response.ok) {
        setEntries(null);
        setError(UNAVAILABLE_MESSAGE);
        return;
      }
      const payload = (await response.json()) as RoleInventoryResponse;
      setEntries(
        Array.isArray(payload.roles)
          ? payload.roles.filter(
              (item): item is RoleInventoryEntry =>
                !!item && typeof item === "object",
            )
          : [],
      );
    } catch {
      setEntries(null);
      setError(UNAVAILABLE_MESSAGE);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleEntries = useMemo(() => {
    const list = entries ?? [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return list;
    return list.filter((entry) =>
      [
        roleLabel(entry.role),
        String(entry.role ?? ""),
        String(entry.displayName ?? ""),
        String(entry.createdAt ?? ""),
      ].some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [entries, query]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">管理员角色清单</h2>
          <p className="mt-1 text-sm text-stone-500">
            只读投影：仅展示角色、用户显示名与创建时间，不包含凭据、主体标识或账户数据；此面板不提供任何变更操作。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-xl border border-stone-300 px-4 py-2 text-sm hover:bg-white disabled:opacity-50"
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索角色、显示名或授予时间"
        className="w-full max-w-xl rounded-xl border border-stone-300 bg-white px-4 py-3 text-sm outline-none focus:border-ember-500"
      />

      {loading ? (
        <div className="rounded-2xl border border-stone-200 bg-white px-6 py-10 text-center text-sm text-stone-500">
          正在加载角色清单…
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-6 py-10 text-center">
          <p className="text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 rounded-xl border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-white"
          >
            重试
          </button>
        </div>
      ) : !entries?.length ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-12 text-center">
          <p className="font-medium text-stone-800">暂无管理员角色记录</p>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-500">
            当前服务端存储中还没有可展示的角色授予记录。
          </p>
        </div>
      ) : !visibleEntries.length ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-12 text-center">
          <p className="font-medium text-stone-800">没有匹配的角色记录</p>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-500">
            请调整搜索关键词后重试。
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                {["角色", "用户", "授予时间"].map((item) => (
                  <th key={item} className="px-4 py-3 font-medium">
                    {item}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry, index) => (
                <tr
                  key={`${entry.role}-${entry.createdAt}-${index}`}
                  className="border-t border-stone-100"
                >
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-700">
                      {roleLabel(entry.role)}
                    </span>
                  </td>
                  <td className="px-4 py-3">{entry.displayName || "—"}</td>
                  <td className="px-4 py-3 text-stone-500">
                    {formatCreatedAt(entry.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
