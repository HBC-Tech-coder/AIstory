import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthModal } from "@/components/AuthModal";

type VerifyMode = "pending" | "error403" | "success";
type ClaimMode = "immediate" | "pending";

type ClaimControl = {
  mode: ClaimMode;
  started: number;
  resolved: number;
  pendingResolve: (() => void) | null;
  applyMode: ClaimMode;
  applyStarted: number;
  applyResolved: number;
  pendingApplyResolve: (() => void) | null;
};

type AuthModalMockApi = {
  setVerifyMode: (mode: VerifyMode) => void;
  setClaimMode: (mode: ClaimMode) => void;
  setClaimApplyMode: (mode: ClaimMode) => void;
  resolvePending: (status: number, body: unknown) => boolean;
  resolveClaim: () => boolean;
  resolveClaimApply: () => boolean;
  readAccount: () => Promise<unknown>;
  getDocumentCookie: () => string;
  getCounts: () => {
    request: number;
    verify: number;
    receiverMismatch: number;
    claimStarted: number;
    claimResolved: number;
    claimApplyStarted: number;
    claimApplyResolved: number;
    accountChanged: number;
  };
  resetCounts: () => void;
};

type MockWindow = typeof window & {
  __authModalMock?: AuthModalMockApi;
  __authModalClaimControl?: ClaimControl;
};

let verifyMode: VerifyMode = "error403";
let requestCount = 0;
let verifyCount = 0;
let receiverMismatchCount = 0;
let accountChangedCount = 0;
let pendingResolve: ((status: number, body: unknown) => void) | null = null;
const claimControl: ClaimControl = {
  mode: "immediate",
  started: 0,
  resolved: 0,
  pendingResolve: null,
  applyMode: "immediate",
  applyStarted: 0,
  applyResolved: 0,
  pendingApplyResolve: null,
};
(window as MockWindow).__authModalClaimControl = claimControl;
window.addEventListener("aistory:account-changed", () => {
  accountChangedCount += 1;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = window.fetch.bind(window);

(window as MockWindow).fetch = async function (
  this: typeof window,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  if (this !== window) {
    receiverMismatchCount += 1;
    throw new TypeError("Illegal invocation");
  }
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  if (url.includes("/api/auth/phone/request")) {
    requestCount += 1;
    return jsonResponse(202, {
      challengeId: "challenge-browser-smoke",
      maskedPhone: "138****8000",
      expiresInSeconds: 300,
      retryAfterSeconds: 30,
    });
  }

  if (url.includes("/api/auth/phone/verify")) {
    verifyCount += 1;
    if (verifyMode === "pending") {
      return new Promise<Response>((resolve) => {
        pendingResolve = (status, body) => {
          pendingResolve = null;
          resolve(jsonResponse(status, body));
        };
      });
    }
    if (verifyMode === "error403") {
      return jsonResponse(403, {
        error: "Unauthorized",
        code: "FORBIDDEN",
        message: "raw server text should never render",
      });
    }
    return originalFetch(input, init);
  }

  return originalFetch(input, init);
};

(window as MockWindow).__authModalMock = {
  setVerifyMode(mode) {
    verifyMode = mode;
  },
  setClaimMode(mode) {
    claimControl.mode = mode;
  },
  setClaimApplyMode(mode) {
    claimControl.applyMode = mode;
  },
  resolvePending(status, body) {
    if (!pendingResolve) return false;
    pendingResolve(status, body);
    return true;
  },
  resolveClaim() {
    if (!claimControl.pendingResolve) return false;
    const resolve = claimControl.pendingResolve;
    claimControl.pendingResolve = null;
    resolve();
    return true;
  },
  resolveClaimApply() {
    if (!claimControl.pendingApplyResolve) return false;
    const resolve = claimControl.pendingApplyResolve;
    claimControl.pendingApplyResolve = null;
    resolve();
    return true;
  },
  async readAccount() {
    const response = await originalFetch("/api/account/me", {
      cache: "no-store",
    });
    return response.json();
  },
  getDocumentCookie() {
    return document.cookie;
  },
  getCounts() {
    return {
      request: requestCount,
      verify: verifyCount,
      receiverMismatch: receiverMismatchCount,
      claimStarted: claimControl.started,
      claimResolved: claimControl.resolved,
      claimApplyStarted: claimControl.applyStarted,
      claimApplyResolved: claimControl.applyResolved,
      accountChanged: accountChangedCount,
    };
  },
  resetCounts() {
    requestCount = 0;
    verifyCount = 0;
    receiverMismatchCount = 0;
    claimControl.mode = "immediate";
    claimControl.started = 0;
    claimControl.resolved = 0;
    claimControl.pendingResolve = null;
    claimControl.applyMode = "immediate";
    claimControl.applyStarted = 0;
    claimControl.applyResolved = 0;
    claimControl.pendingApplyResolve = null;
    accountChangedCount = 0;
  },
};

export function AuthModalBrowserHarness() {
  const [open, setOpen] = useState(false);
  const [closeCount, setCloseCount] = useState(0);
  const [successCount, setSuccessCount] = useState(0);
  const [parentClickCount, setParentClickCount] = useState(0);

  return (
    <div
      id="profile-like-shell"
      onClick={() => setParentClickCount((count) => count + 1)}
      style={{
        height: 130,
        overflow: "hidden",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        border: "1px solid #cbd5e1",
        padding: 12,
        boxSizing: "border-box",
        background: "rgba(255,255,255,0.72)",
      }}
    >
      <button
        id="open-auth-modal"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        Open login
      </button>
      <span id="parent-click-count">{parentClickCount}</span>
      <span id="close-count">{closeCount}</span>
      <span id="success-count">{successCount}</span>
      {open && (
        <AuthModal
          onClose={() => {
            setCloseCount((count) => count + 1);
            setOpen(false);
          }}
          onSuccess={() => {
            setSuccessCount((count) => count + 1);
            setOpen(false);
          }}
          requirement={{ message: "Unauthorized" }}
        />
      )}
    </div>
  );
}

const mountNode = document.getElementById("root");
if (mountNode) {
  createRoot(mountNode).render(<AuthModalBrowserHarness />);
}
