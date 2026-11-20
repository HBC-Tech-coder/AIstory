import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LinghaoPassportV4EntryPanel from "@/components/LinghaoPassportV4EntryPanel";

const LOGOUT_STATE = "s".repeat(43);

type Snapshot = Readonly<{
  loggedOutPosts: number;
  sessionGets: number;
  capabilityGets: number;
  unknownRequests: number;
  pathname: string;
  search: string;
  notice: string;
  logoutAction: string | null;
  closedEntryVisible: boolean;
}>;

declare global {
  interface Window {
    __linghaoPassportV4EntrySmoke?: {
      snapshot: () => Snapshot;
    };
  }
}

let loggedOutPosts = 0;
let sessionGets = 0;
let capabilityGets = 0;
let unknownRequests = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  const url = new URL(raw, window.location.origin);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

  if (url.pathname === "/api/auth/linghao-passport-v4/capabilities" && method === "GET") {
    capabilityGets += 1;
    return json({ enabled: true, mode: "production", publicEntry: false });
  }
  if (url.pathname === "/api/auth/linghao-passport-v4/session" && method === "GET") {
    sessionGets += 1;
    return json({
      authenticated: true,
      account: {
        authType: "passport_v4",
        displayName: "灵号通行证用户",
        status: "active",
        expiresAt: Date.now() + 60 * 60 * 1000,
        balance: null,
        ledger: [],
        capabilities: {
          ordinaryProductAccess: true,
          newContentNamespace: true,
          legacyAccountRead: false,
          legacyAccountLink: false,
          administrator: false,
          phoneAccount: false,
          formalWallet: false,
          platformPaidGeneration: false,
          cloudProgress: false,
          hostedByok: false,
        },
      },
    });
  }
  if (
    url.pathname === "/api/auth/linghao-passport-v4/logged-out"
    && url.searchParams.get("state") === LOGOUT_STATE
    && method === "POST"
  ) {
    loggedOutPosts += 1;
    await Promise.resolve();
    return json({
      status: "consumed",
      localLoggedOut: true,
      revocationConfirmed: true,
      upstreamReturnConfirmed: true,
    });
  }

  unknownRequests += 1;
  return json({ error: "unexpected fixture request" }, 404);
};

window.__linghaoPassportV4EntrySmoke = {
  snapshot: () => {
    const text = document.body.textContent ?? "";
    return {
      loggedOutPosts,
      sessionGets,
      capabilityGets,
      unknownRequests,
      pathname: window.location.pathname,
      search: window.location.search,
      notice: document.querySelector("[aria-live='polite']")?.textContent ?? "",
      logoutAction: document.querySelector<HTMLFormElement>(
        "form[action='/api/auth/linghao-passport-v4/logout']",
      )?.getAttribute("action") ?? null,
      closedEntryVisible: text.includes("正式入口尚未开放"),
    };
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("fixture root missing");
createRoot(root).render(
  <StrictMode>
    <LinghaoPassportV4EntryPanel />
  </StrictMode>,
);
