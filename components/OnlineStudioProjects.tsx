"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  StudioDraftV1,
  StudioOwnerProject,
  StudioOwnerSummary,
  StudioProjectVisibility,
  StudioPublishedSnapshotV1,
  StudioDraftScene,
} from "@/lib/creator-studio/online/types";

type StudioApiError = { code?: string; error?: string };

const EMPTY_EDITOR = {
  title: "",
  synopsis: "",
  authoringNotes: "",
  scenes: [{ id: "scene-1", heading: "第一场", body: "" }] as StudioDraftScene[],
};

type Editor = typeof EMPTY_EDITOR;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = payload as StudioApiError | null;
    const error = new Error(failure?.error || `请求失败（${response.status}）`);
    Object.assign(error, { status: response.status, code: failure?.code });
    throw error;
  }
  return payload as T;
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return "服务暂不可用，请稍后重试。";
  const status = (error as Error & { status?: number }).status;
  if (status === 401) return "请先登录，再创建和编辑自己的作品。";
  if (status === 409) return "作品已在其他页面更新。请刷新作品后重试。";
  if (status === 503) return "在线作品库尚未启用或暂不可用。";
  return error.message;
}

function toEditor(draft: StudioDraftV1): Editor {
  return {
    title: draft.title,
    synopsis: draft.synopsis ?? "",
    authoringNotes: draft.authoringNotes ?? "",
    scenes: draft.scenes.map((scene) => ({ ...scene })),
  };
}

function toDraft(editor: Editor): StudioDraftV1 {
  return {
    v: 1,
    title: editor.title.trim(),
    ...(editor.synopsis.trim() ? { synopsis: editor.synopsis.trim() } : {}),
    ...(editor.authoringNotes.trim()
      ? { authoringNotes: editor.authoringNotes.trim() }
      : {}),
    scenes: editor.scenes.map((scene) => ({
      id: scene.id,
      heading: scene.heading.trim(),
      body: scene.body.trim(),
    })),
  };
}

function toPublished(editor: Editor): StudioPublishedSnapshotV1 {
  const draft = toDraft(editor);
  return {
    v: 1,
    title: draft.title,
    ...(draft.synopsis ? { synopsis: draft.synopsis } : {}),
    scenes: draft.scenes.map(({ id, heading, body }) => ({ id, heading, body })),
  };
}

function readableDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

export function OnlineStudioProjects({ homeHref, studioHref }: { homeHref: string; studioHref: string }) {
  const [items, setItems] = useState<StudioOwnerSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<StudioOwnerProject | null>(null);
  const [editor, setEditor] = useState<Editor>({ ...EMPTY_EDITOR, scenes: [...EMPTY_EDITOR.scenes] });
  const [visibility, setVisibility] = useState<StudioProjectVisibility>("public");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await requestJson<{ items: StudioOwnerSummary[]; nextCursor: string | null }>("/api/studio/projects");
      setItems(result.items ?? []);
      setNextCursor(result.nextCursor ?? null);
    } catch (error) {
      setItems([]);
      setNextCursor(null);
      setNotice(formatError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function loadMore() {
    if (!nextCursor || busy) return;
    setBusy(true);
    try {
      const result = await requestJson<{ items: StudioOwnerSummary[]; nextCursor: string | null }>(
        `/api/studio/projects?cursor=${encodeURIComponent(nextCursor)}`,
      );
      setItems((current) => [...current, ...(result.items ?? [])]);
      setNextCursor(result.nextCursor ?? null);
    } catch (error) {
      setNotice(formatError(error));
    } finally {
      setBusy(false);
    }
  }

  async function openProject(id: string) {
    setBusy(true);
    try {
      const project = await requestJson<StudioOwnerProject>(
        `/api/studio/projects/${encodeURIComponent(id)}`,
      );
      setSelected(project);
      setEditor(toEditor(project.draft));
      setVisibility(project.published ? project.visibility : "public");
      setNotice("");
    } catch (error) {
      setNotice(formatError(error));
    } finally {
      setBusy(false);
    }
  }

  function startNew() {
    setSelected(null);
    setEditor({ ...EMPTY_EDITOR, scenes: [{ id: "scene-1", heading: "第一场", body: "" }] });
    setVisibility("public");
    setNotice("");
  }

  function updateScene(index: number, patch: Partial<StudioDraftScene>) {
    setEditor((current) => ({
      ...current,
      scenes: current.scenes.map((scene, position) =>
        position === index ? { ...scene, ...patch } : scene),
    }));
  }

  function addScene() {
    setEditor((current) => ({
      ...current,
      scenes: [...current.scenes, {
        id: `scene-${crypto.randomUUID()}`,
        heading: `第 ${current.scenes.length + 1} 场`,
        body: "",
      }],
    }));
  }

  function removeScene(index: number) {
    setEditor((current) => current.scenes.length <= 1
      ? current
      : { ...current, scenes: current.scenes.filter((_, position) => position !== index) });
  }

  async function save() {
    setBusy(true);
    try {
      const draft = toDraft(editor);
      const project = selected
        ? await requestJson<StudioOwnerProject>(
            `/api/studio/projects/${encodeURIComponent(selected.id)}`,
            { method: "PUT", body: JSON.stringify({ expectedRevision: selected.revision, draft }) },
          )
        : await requestJson<StudioOwnerProject>("/api/studio/projects", {
            method: "POST", body: JSON.stringify({ draft }),
          });
      setSelected(project);
      setEditor(toEditor(project.draft));
      setNotice("私有草稿已保存。发布前，其他用户无法查看。");
      await refresh();
    } catch (error) {
      setNotice(formatError(error));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!selected) {
      setNotice("请先保存草稿，再发布作品。");
      return;
    }
    if (JSON.stringify(toDraft(editor)) !== JSON.stringify(selected.draft)) {
      setNotice("请先保存草稿，再发布当前内容。");
      return;
    }
    setBusy(true);
    try {
      const summary = await requestJson<StudioOwnerSummary>(
        `/api/studio/projects/${encodeURIComponent(selected.id)}`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedRevision: selected.revision,
            visibility,
            published: toPublished(editor),
          }),
        },
      );
      setSelected({ ...selected, ...summary });
      setNotice(visibility === "public" ? "作品已公开发布。" : "作品已发布并隐藏。");
      await refresh();
    } catch (error) {
      setNotice(formatError(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeVisibility(next: StudioProjectVisibility) {
    if (!selected?.published) return;
    setBusy(true);
    try {
      const summary = await requestJson<StudioOwnerSummary>(
        `/api/studio/projects/${encodeURIComponent(selected.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ expectedRevision: selected.revision, visibility: next }),
        },
      );
      setSelected({ ...selected, ...summary });
      setVisibility(summary.visibility);
      setNotice(next === "public" ? "作品已公开。" : "作品已隐藏。公开链接现在不可访问。");
      await refresh();
    } catch (error) {
      setNotice(formatError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="ui-page min-h-screen">
      <header className="ui-surface border-b px-4 py-4">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <a href={homeHref} className="ui-button-secondary border px-3 py-2 text-sm">返回首页</a>
          <div>
            <h1 className="font-serif text-2xl">AIstory 在线创作者工作台</h1>
            <p className="ui-muted text-sm">创建和编辑自己的作品；公开发布后可随时隐藏。</p>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-6 p-4 lg:grid-cols-[280px_minmax(0,1fr)] lg:p-6">
        <aside className="ui-surface h-fit border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">我的作品</h2>
            <button type="button" className="ui-button-secondary border px-2 py-1 text-sm" onClick={startNew}>新建</button>
          </div>
          {loading ? <p className="ui-muted mt-4 text-sm">正在读取作品…</p> : null}
          {!loading && items.length === 0 ? <p className="ui-muted mt-4 text-sm">暂无在线作品。</p> : null}
          <ul className="mt-3 space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => void openProject(item.id)}
                  className={`w-full border p-3 text-left text-sm ${selected?.id === item.id ? "border-ember-500" : "border-clay-300"}`}>
                  <span className="block font-medium">{item.title}</span>
                  <span className="ui-muted mt-1 block text-xs">{item.published ? (item.visibility === "public" ? "公开" : "已隐藏") : "私有草稿"} · {readableDate(item.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {nextCursor ? <button type="button" disabled={busy} onClick={() => void loadMore()} className="ui-button-secondary mt-3 border px-3 py-1.5 text-sm">加载更多</button> : null}
          <button type="button" onClick={() => void refresh()} className="ui-button-secondary mt-4 border px-3 py-1.5 text-sm">刷新</button>
        </aside>
        <section className="ui-surface border p-4 lg:p-6">
          <h2 className="font-serif text-xl">{selected ? "编辑作品" : "创建作品"}</h2>
          <p className="ui-muted mt-1 text-sm">编辑内容保存在私有草稿；发布时生成独立的公开内容。</p>
          {notice ? <p role="status" className="mt-4 border border-amber-700/20 bg-amber-50 p-3 text-sm text-amber-900">{notice}</p> : null}
          <div className="mt-5 grid gap-4">
            <label className="block text-sm">作品标题
              <input className="ui-input mt-1 w-full" maxLength={200} value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} />
            </label>
            <label className="block text-sm">简介
              <textarea className="ui-input mt-1 w-full" rows={3} maxLength={2000} value={editor.synopsis} onChange={(event) => setEditor({ ...editor, synopsis: event.target.value })} />
            </label>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">场景</h3>
              <button type="button" disabled={busy || editor.scenes.length >= 100} onClick={addScene} className="ui-button-secondary border px-2 py-1 text-sm">添加场景</button>
            </div>
            {editor.scenes.map((scene, index) => (
              <div key={scene.id} className="grid gap-3 border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">场景 {index + 1}</span>
                  <button type="button" disabled={busy || editor.scenes.length <= 1} onClick={() => removeScene(index)} className="ui-button-secondary border px-2 py-1 text-xs">删除场景</button>
                </div>
                <label className="block text-sm">场景标题
                  <input className="ui-input mt-1 w-full" maxLength={200} value={scene.heading} onChange={(event) => updateScene(index, { heading: event.target.value })} />
                </label>
                <label className="block text-sm">场景内容
                  <textarea className="ui-input mt-1 w-full" rows={10} maxLength={8000} value={scene.body} onChange={(event) => updateScene(index, { body: event.target.value })} />
                </label>
              </div>
            ))}
            <label className="block text-sm">私有创作笔记（不会发布）
              <textarea className="ui-input mt-1 w-full" rows={4} maxLength={8000} value={editor.authoringNotes} onChange={(event) => setEditor({ ...editor, authoringNotes: event.target.value })} />
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} onClick={() => void save()} className="ui-button-primary px-4 py-2 text-sm">保存私有草稿</button>
            {selected ? (
              <>
                <label className="text-sm">发布可见性
                  <select className="ui-input ml-2" value={visibility} onChange={(event) => setVisibility(event.target.value as StudioProjectVisibility)}>
                    <option value="public">公开（默认）</option>
                    <option value="hidden">隐藏</option>
                  </select>
                </label>
                <button type="button" disabled={busy} onClick={() => void publish()} className="ui-button-secondary border px-4 py-2 text-sm">发布当前内容</button>
                {selected.published && selected.visibility !== visibility ? (
                  <button type="button" disabled={busy} onClick={() => void changeVisibility(visibility)} className="ui-button-secondary border px-4 py-2 text-sm">仅更改可见性</button>
                ) : null}
                {selected.published && selected.visibility === "public" ? (
                  <a className="ui-primary text-sm underline" href={`${studioHref}/work/${encodeURIComponent(selected.id)}`} target="_blank" rel="noreferrer">查看公开作品</a>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
