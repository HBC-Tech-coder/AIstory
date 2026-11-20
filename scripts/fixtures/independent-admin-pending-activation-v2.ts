// Synthetic, in-memory test double only. Never imported by app/lib runtime code.
import { firstChangeBinding, firstChangePasswordState, FIRST_PASSWORD_CHANGE_ENV,
  FIRST_PASSWORD_CHANGE_GATE, FIRST_PASSWORD_CHANGE_POLICY } from "@/lib/admin/independentFirstPasswordChange";
import { createFirstChangeIndependentAdminCredential, serializeIndependentAdminPrincipalCredential,
  type IndependentAdminPrincipalCredential } from "@/lib/admin/independentPrincipal";
import { handleIndependentAdminPrincipalProductionLogin, handleIndependentAdminPrincipalProductionMe,
  handleIndependentAdminPrincipalProductionLogout, handleIndependentAdminPasswordChange,
  independentAdminNavigationState, resolveIndependentAdminPrincipalAuthorizedContext,
  INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE, independentAdminPrincipalProductionCookieOptions,
  type IndependentAdminPrincipalServerOptions } from "@/lib/admin/independentPrincipalServer";
import type { IncomingMessage } from "node:http";

export const syntheticAdminOrigin = "https://admin.example.invalid";
export const syntheticAdminEnvironment = Object.freeze({
  AISTORY_ADMIN_PRINCIPAL_MODE: "aistory-independent-admin-principal-v1:production_v1",
  AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE: "/run/synthetic/admin-seed.json",
  AISTORY_ADMIN_PRINCIPAL_DATABASE_GATE_VERSION: "20260829063000",
  AISTORY_ADMIN_PRINCIPAL_PUBLIC_ORIGIN: syntheticAdminOrigin,
  [FIRST_PASSWORD_CHANGE_ENV]: FIRST_PASSWORD_CHANGE_POLICY,
  AISTORY_TRUST_PROXY_HEADERS: "true", AISTORY_PRODUCTION_IDENTITY_ENABLED: "true",
  AISTORY_IDENTITY_REPOSITORY: "supabase", AISTORY_ADMIN_REPOSITORY: "supabase",
  AISTORY_DATABASE_GATE_VERSION: "20260811193000", AISTORY_ANONYMOUS_SESSION_SECRET: "s".repeat(48),
  AISTORY_ANONYMOUS_SUBJECT_PEPPER: "p".repeat(48), AISTORY_SUPABASE_SERVER_URL: "https://db.example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-key",
});

type Session = { family: string; expiresAt: number; revoked: boolean };
const rateWindow = 15 * 60 * 1000;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class PendingActivationFake {
  credential: IndependentAdminPrincipalCredential;
  restricted = true;
  revision = 1;
  now: number;
  readonly sessions = new Map<string, Session>();
  readonly families = new Map<string, { revoked: boolean; revision: number; restricted: boolean; binding: string; expiresAt: number }>();
  readonly audit: string[] = [];
  readonly calls: string[] = [];
  ticket?: string;
  ticketSession?: string;
  ticketExpiresAt = 0;
  attempts = 0;
  private windowStartedAt: number;
  private loginAttempts = new Map<string, { count: number; startedAt: number }>();
  failCommit = false;
  unknownCommit = false;
  failRead = false;
  gate: unknown = FIRST_PASSWORD_CHANGE_GATE;
  drift?: unknown;

  constructor(readonly seed: IndependentAdminPrincipalCredential, now: number) {
    this.credential = seed; this.now = now; this.windowStartedAt = now;
  }

  get active() { return [...this.sessions].find(([, s]) => !s.revoked && s.expiresAt > this.now)?.[0]; }

  options(): IndependentAdminPrincipalServerOptions {
    return { env: syntheticAdminEnvironment, now: this.now, client: this as never,
      loadCredentialFile: async () => serializeIndependentAdminPrincipalCredential(this.seed) };
  }

  private revokeAll() {
    for (const session of this.sessions.values()) session.revoked = true;
    for (const family of this.families.values()) family.revoked = true;
  }

  private bindingCurrent(p: Record<string, unknown>) {
    return Object.entries(firstChangeBinding(this.credential)).every(([key, value]) => same(p[key], value));
  }

  private currentSession(p: Record<string, unknown>) {
    const session = this.sessions.get(String(p.session_hash));
    const family = session && this.families.get(session.family);
    return this.bindingCurrent(p) && !!session && !session.revoked && session.expiresAt > this.now
      && family?.revoked === false && family.expiresAt > this.now
      && family.revision === this.revision && family.restricted === this.restricted
      && family.binding === firstChangeBinding(this.credential).credential_binding_sha256;
  }

  async rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
    this.calls.push(name);
    const ok = (data: unknown) => ({ data, error: null });
    const no = () => ({ data: null, error: { message: "SYNTHETIC_PRIVATE_EXCEPTION_DO_NOT_RETURN" } });
    const p = (args?.request_payload ?? args?.login ?? args?.session ?? args?.attempt
      ?? args?.security_event ?? args?.rotation ?? {}) as Record<string, unknown>;
    if (name === "aistory_database_gate_status") return ok("20260811193000");
    if (name === "aistory_independent_admin_gate_status") return ok("20260829063000");
    if (name.endsWith("security_posture")) return ok(true);
    if (name === "aistory_iap_first_change_posture") return ok(this.gate);
    if (name === "aistory_iap_first_change_read_credential") {
      if (this.failRead || p.principal_ref !== this.seed.principalId
        || p.root_binding_sha256 !== firstChangeBinding(this.seed).credential_binding_sha256) return no();
      return ok(this.drift !== undefined ? this.drift : {
        password_state: firstChangePasswordState(this.credential), must_change_password: this.restricted,
        revision: this.revision, binding: firstChangeBinding(this.credential),
      });
    }
    if (name === "aistory_independent_admin_reserve_login") {
      if (!this.bindingCurrent(p)) return no();
      const keys = [String(p.global_bucket_hash), String(p.subject_bucket_hash)];
      for (const key of keys) {
        const current = this.loginAttempts.get(key);
        if (!current || current.startedAt <= this.now - rateWindow) this.loginAttempts.set(key, { count: 0, startedAt: this.now });
      }
      const limited = keys.find((key, index) => this.loginAttempts.get(key)!.count >= (index === 0 ? 100 : 5));
      if (limited) {
        this.audit.push("rate_limited"); return ok({ allowed: false,
          retry_after_seconds: Math.max(1, Math.ceil((this.loginAttempts.get(limited)!.startedAt + rateWindow - this.now) / 1000)) });
      }
      for (const key of keys) this.loginAttempts.get(key)!.count++;
      return ok({ allowed: true, retry_after_seconds: 0 });
    }
    if (name === "aistory_independent_admin_append_security_event") { this.audit.push(String(p.event)); return ok(true); }
    if (name === "aistory_iap_first_change_access_denied") {
      if (!this.restricted || !this.currentSession(p)) return no();
      this.audit.push("restricted_access_denied"); return ok(true);
    }
    if (name === "aistory_independent_admin_commit_login") {
      if (!this.bindingCurrent(p) || this.sessions.has(String(p.session_hash)) || this.families.has(String(p.family_hash))) return no();
      const occurredAt = Date.parse(String(p.occurred_at)), expiresAt = Date.parse(String(p.expires_at));
      if (!Number.isFinite(occurredAt) || Math.abs(this.now - occurredAt) > 60_000
        || expiresAt - occurredAt !== rateWindow || expiresAt <= this.now) return no();
      // Matches the existing single-active-family contract; retain revoked history.
      this.revokeAll();
      this.families.set(String(p.family_hash), { revoked: false, revision: this.revision, restricted: this.restricted,
        binding: firstChangeBinding(this.credential).credential_binding_sha256, expiresAt });
      this.sessions.set(String(p.session_hash), { family: String(p.family_hash), revoked: false,
        expiresAt });
      for (const key of p.bucket_hashes as string[]) this.loginAttempts.delete(key);
      this.audit.push(this.restricted ? "temporary_login" : "normal_login"); return ok(true);
    }
    if (name === "aistory_iap_first_change_verify_session") return ok(this.currentSession(p)
      ? { active: true, must_change_password: this.restricted } : null);
    if (name === "aistory_independent_admin_verify_session") return ok(!this.restricted && this.currentSession(p)
      ? { active: true, role: "super_admin" } : null);
    if (name === "aistory_independent_admin_revoke_session") {
      if (this.currentSession(p)) {
        const session = this.sessions.get(String(p.session_hash))!; session.revoked = true;
        this.families.get(session.family)!.revoked = true; this.audit.push("logout");
      }
      return ok(true);
    }
    if (name === "aistory_independent_admin_rotate_session") return no();
    if (name === "aistory_independent_admin_read_snapshot") {
      if (this.restricted || !this.currentSession(p)) return no();
      return ok(Object.fromEntries(["users", "roles", "accounts", "ledger", "events", "settings", "payment_configs",
        "provider_configs", "domains", "channel_apps", "audit", "billing_policies"].map(key => [key, []])));
    }
    if (name === "aistory_iap_first_change_reserve") {
      if (!this.restricted || !this.currentSession(p)) return no();
      if (this.windowStartedAt <= this.now - rateWindow) { this.attempts = 0; this.windowStartedAt = this.now; }
      if (this.attempts >= 5) { this.audit.push("password_change_rate_limited"); return ok({ allowed: false }); }
      this.attempts++; this.ticket = String(p.ticket_hash); this.ticketSession = String(p.session_hash);
      this.ticketExpiresAt = this.now + 60_000; this.audit.push("password_change_attempt"); return ok({ allowed: true });
    }
    if (name === "aistory_iap_first_change_complete") {
      if (this.failCommit || !this.restricted || this.revision !== 1 || this.ticket !== p.ticket_hash
        || this.ticketSession !== p.session_hash || this.ticketExpiresAt <= this.now
        || !same(p.current_binding, firstChangeBinding(this.credential))
        || !this.currentSession({ ...firstChangeBinding(this.credential), session_hash: p.session_hash })) return no();
      const candidate = { ...this.seed, ...(p.password_state as object) } as IndependentAdminPrincipalCredential;
      if (!same(p.next_binding, firstChangeBinding(candidate)) || same(p.current_binding, p.next_binding)) return no();
      // No await between CAS and commit: synthetic atomic section, not a real DB proof.
      this.credential = candidate; this.restricted = false; this.revision = 2;
      this.revokeAll(); this.ticket = undefined; this.ticketSession = undefined; this.ticketExpiresAt = 0;
      this.audit.push("credential_rotated", "password_change_succeeded");
      return this.unknownCommit ? no() : ok(true);
    }
    // Initializer/bootstrap/other business methods are intentionally not implemented.
    return no();
  }
}

// Loopback HTTP transport for the real server handlers and real React forms.
// The only substitution is synthetic runtime/DB plus an explicit HTTPS request
// projection. This is NOT a Next production proxy or deployment qualification.
export async function createPendingActivationHttpFixture() {
  const seed = await createFirstChangeIndependentAdminCredential({ username: "admin", password: "admin888" });
  const fake = new PendingActivationFake(seed, Date.now());
  let deniedBusinessRequests = 0;
  const cookieName = INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_COOKIE;
  const json = (value: object, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const redirect = (to: string) => new Response(null, { status: 307, headers: { Location: to, "Cache-Control": "no-store" } });
  const cookie = (token: string, clear = false) => {
    const settings = independentAdminPrincipalProductionCookieOptions();
    if (!settings.secure || !settings.httpOnly || settings.sameSite !== "strict" || settings.path !== "/") throw Error("synthetic_cookie_contract");
    return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : settings.maxAge}`;
  };
  async function handle(request: IncomingMessage): Promise<Response | undefined> {
    const localOrigin = `http://127.0.0.1:${request.socket.localPort}`;
    if (request.socket.remoteAddress !== "127.0.0.1" || request.socket.localAddress !== "127.0.0.1"
      || request.headers.host !== new URL(localOrigin).host) return json({ error: "Forbidden" }, 403);
    const url = new URL(request.url ?? "/", localOrigin);
    const cookies = (request.headers.cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(cookieName + "="));
    if (cookies.length > 1) return json({ error: "Forbidden" }, 403);
    const token = cookies[0]?.slice(cookieName.length + 1);
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/__harness/state") return json({
      restricted: fake.restricted, revision: fake.revision, activeSessions: fake.active ? 1 : 0,
      sessionHistory: fake.sessions.size, familyHistory: fake.families.size,
      changes: fake.audit.filter(e => e === "password_change_succeeded").length,
      snapshots: fake.calls.filter(n => n === "aistory_independent_admin_read_snapshot").length,
      bootstrapCalls: fake.calls.filter(n => n.includes("bootstrap") || n.includes("initialize")).length,
      deniedBusinessRequests,
    });
    if (method === "GET" && ["/admin/login", "/admin/password-change", "/admin"].includes(url.pathname)) {
      const state = await independentAdminNavigationState(token, fake.options());
      if (url.pathname === "/admin/password-change" && state !== "password_change_required") {
        return redirect(state === "console" ? "/admin" : token ? "/admin/login?state=session-ended" : "/admin/login");
      }
      if (url.pathname === "/admin/login" && state !== "signed_out") {
        return redirect(state === "console" ? "/admin" : "/admin/password-change");
      }
      if (url.pathname === "/admin") {
        const authorized = await resolveIndependentAdminPrincipalAuthorizedContext(token, fake.options());
        if (!authorized) return redirect(state === "password_change_required" ? "/admin/password-change" : "/admin/login?state=session-ended");
      }
      return undefined;
    }
    if (method === "GET" && url.pathname === "/api/admin/session") {
      const result = await handleIndependentAdminPrincipalProductionMe(token, fake.options());
      if (result.response.status === 401) result.response.headers.set("Set-Cookie", cookie("", true));
      return result.response;
    }
    if (method === "GET" && url.pathname === "/api/admin/snapshot") {
      const authorized = await resolveIndependentAdminPrincipalAuthorizedContext(token, fake.options());
      if (!authorized) return json({ error: "Forbidden" }, 403);
      await authorized.repository.readAdminSnapshot(authorized.databaseContext);
      return json({ safeRead: true });
    }
    if (!["POST", "DELETE"].includes(method)) return undefined;
    if (request.headers.origin !== localOrigin) return json({ error: "Forbidden" }, 403);
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of request) {
      const chunk = Buffer.from(part); size += chunk.length;
      if (size > 4096) return json({ error: "Forbidden" }, 403);
      chunks.push(chunk);
    }
    if (url.pathname === "/__harness/advance" && method === "POST") {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Object.keys(body).join() !== "milliseconds"
        || !("milliseconds" in body) || !Number.isSafeInteger(body.milliseconds)
        || Number(body.milliseconds) < 0 || Number(body.milliseconds) > 30 * 86400000) return json({ error: "Forbidden" }, 403);
      fake.now += Number(body.milliseconds); return json({ advanced: true });
    }
    const headers = new Headers({ host: new URL(syntheticAdminOrigin).host, origin: syntheticAdminOrigin });
    for (const key of ["content-type", "content-length", "x-aistory-admin-action", "sec-fetch-site"]) {
      const value = request.headers[key]; if (typeof value === "string") headers.set(key, value);
    }
    const projected = new Request(syntheticAdminOrigin + url.pathname + url.search, { method, headers, body: Buffer.concat(chunks) });
    if (url.pathname === "/api/admin/session" && method === "POST") {
      const result = await handleIndependentAdminPrincipalProductionLogin(projected, fake.options());
      if (result.sessionToken) result.response.headers.set("Set-Cookie", cookie(result.sessionToken));
      return result.response;
    }
    if (url.pathname === "/api/admin/session" && method === "DELETE") {
      const response = await handleIndependentAdminPrincipalProductionLogout(projected, token, fake.options());
      if (response.status === 200) response.headers.set("Set-Cookie", cookie("", true));
      return response;
    }
    if (url.pathname === "/api/admin/password-change" && method === "POST") {
      const result = await handleIndependentAdminPasswordChange(projected, token, fake.options());
      if (result.response.status === 200) result.response.headers.set("Set-Cookie", cookie("", true));
      return result.response;
    }
    if (url.pathname.startsWith("/api/admin/")) {
      const authorized = await resolveIndependentAdminPrincipalAuthorizedContext(token, fake.options());
      if (fake.restricted && authorized) throw Error("synthetic_pending_authority_regression");
      deniedBusinessRequests++;
      // The independent read-only console never gains legacy business mutations.
      return json({ error: "Forbidden" }, 403);
    }
    return undefined;
  }
  return { handle, fake };
}
