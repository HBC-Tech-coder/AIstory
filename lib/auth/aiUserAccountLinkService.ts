import "server-only";
import { randomBytes } from "node:crypto";
import { decideAiUserAccountLink, type AiUserAccountLinkInput, type AiUserProof, type PhoneProof } from "./aiUserAccountLinkPolicy";
import { clearAiUserLinkIntent, type createAiUserLinkIntents } from "./aiUserAccountLinkSession";

export type AiUserLinkProofs = { aiuser: AiUserProof; phone: PhoneProof };
export type AiUserLinkCommit = Omit<AiUserAccountLinkInput, "existingByAiuser" | "existingByPhone">;
export type AiUserLinkSessionRevocations = Readonly<{
  aiuser: Readonly<Pick<AiUserProof, "principalKey" | "sessionBinding">> | null;
  phone: Readonly<Pick<PhoneProof, "userId" | "sessionBinding">> | null;
}>;
export interface AiUserAccountLinkRepository {
  assertReady(): Promise<void>;
  isLinked(principalKey: string): Promise<boolean>;
  /** Must durably register the exact pending intent and proof bindings before a cookie is published. */
  prepare(input: AiUserLinkCommit): Promise<void>;
  /** Must recheck database time/active phone and consume the intent with mapping+audit atomically. */
  commit(input: AiUserLinkCommit): Promise<"linked" | "already_linked">;
  /** Append-only session tombstones linearize account logout against prepare/confirm. */
  revokeSessions(input: AiUserLinkSessionRevocations): Promise<void>;
}
export type AiUserAccountLinkDependencies = {
  now: () => number;
  readProofs(request: Request): Promise<AiUserLinkProofs | null>;
  intents: ReturnType<typeof createAiUserLinkIntents>;
  repository: AiUserAccountLinkRepository;
  assertOrigin(request: Request): void;
  /** Process-local defense in depth, evaluated only after authentic proofs and keyed by principal. */
  allowMutation(principalKey: string): boolean;
};
const headers = () => new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
function rejected(status = 403) { return Response.json({ ok: false, code: "ACCOUNT_LINK_UNAVAILABLE" }, { status, headers: headers() }); }
export function sameAiUserLinkProofs(left: AiUserLinkProofs, right: AiUserLinkProofs): boolean {
  return left.aiuser.principalKey === right.aiuser.principalKey
    && left.aiuser.sessionBinding === right.aiuser.sessionBinding
    && left.aiuser.authenticatedAt === right.aiuser.authenticatedAt
    && left.aiuser.expiresAt === right.aiuser.expiresAt
    && left.aiuser.membershipGeneration === right.aiuser.membershipGeneration
    && left.phone.userId === right.phone.userId
    && left.phone.sessionBinding === right.phone.sessionBinding
    && left.phone.authenticatedAt === right.phone.authenticatedAt
    && left.phone.expiresAt === right.phone.expiresAt
    && left.phone.active === right.phone.active;
}
function eligibleProofs(proofs: AiUserLinkProofs, now: number): boolean {
  return decideAiUserAccountLink({ schema: "aistory.aiuser-account-link-proof.v1",
    confirmation: { confirmLink: true }, ...proofs,
    intent: { id: "0".repeat(64), principalKey: proofs.aiuser.principalKey,
      phoneUserId: proofs.phone.userId, aiuserSessionBinding: proofs.aiuser.sessionBinding,
      phoneSessionBinding: proofs.phone.sessionBinding, createdAt: now, expiresAt: now + 60000, consumed: false },
    existingByAiuser: null, existingByPhone: null }, now).ok;
}
async function body(request: Request): Promise<string> {
  const reader = request.body?.getReader(); if (!reader) return "";
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 128) throw Error("ACCOUNT_LINK_REJECTED"); chunks.push(part.value); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => undefined); }
}
export function createAiUserAccountLinkService(deps: AiUserAccountLinkDependencies) {
  return async function handle(request: Request): Promise<Response> {
    try {
      deps.assertOrigin(request);
      if (new URL(request.url).search) return rejected();
      if (request.method === "GET") {
        const initial = await deps.readProofs(request); if (!initial || !eligibleProofs(initial, deps.now())) return rejected(401);
        await deps.repository.assertReady();
        const linked = await deps.repository.isLinked(initial.aiuser.principalKey);
        // Do not publish a positive capability from proofs that changed while
        // the uncached database posture/mapping reads were in flight.
        const current = await deps.readProofs(request);
        if (!current || !sameAiUserLinkProofs(initial, current) || !eligibleProofs(current, deps.now())) return rejected();
        return Response.json({ available: true, linked, assetsMerged: false, creditsGranted: false }, { headers: headers() });
      }
      if (request.method !== "POST" || request.headers.get("content-type") !== "application/json"
        || request.headers.get("sec-fetch-site") !== "same-origin") return rejected();
      const input = await body(request);
      // Exact serialized commands reject duplicates, unknown fields and client-supplied proof material.
      if (input !== '{"action":"prepare"}' && input !== '{"action":"confirm","confirmLink":true}') return rejected();
      const proofs = await deps.readProofs(request); if (!proofs) return rejected();
      if (!deps.allowMutation(proofs.aiuser.principalKey)) return rejected();
      await deps.repository.assertReady();
      const now = deps.now();
      const intent = input === '{"action":"prepare"}' ? {
        id: randomBytes(32).toString("hex"), principalKey: proofs.aiuser.principalKey,
        phoneUserId: proofs.phone.userId, aiuserSessionBinding: proofs.aiuser.sessionBinding,
        phoneSessionBinding: proofs.phone.sessionBinding, createdAt: now, expiresAt: now + 60000, consumed: false as const,
      } : await deps.intents.read(request);
      if (!intent) return rejected();
      const proof: AiUserLinkCommit = { schema: "aistory.aiuser-account-link-proof.v1", confirmation: { confirmLink: true }, ...proofs, intent };
      const decision = decideAiUserAccountLink({ ...proof, existingByAiuser: null, existingByPhone: null }, now);
      if (!decision.ok) return rejected();
      if (input === '{"action":"prepare"}') {
        await deps.repository.prepare(proof);
        const resultHeaders = headers(); resultHeaders.append("Set-Cookie", await deps.intents.seal(intent));
        return Response.json({ readyToConfirm: true, expiresInSeconds: 60, assetsMerged: false, creditsGranted: false }, { headers: resultHeaders });
      }
      // Re-resolve, do not extend proof timestamps. The repository also rechecks time after its lock.
      const current = await deps.readProofs(request); if (!current) return rejected();
      const commit: AiUserLinkCommit = { ...proof, ...current };
      if (!decideAiUserAccountLink({ ...commit, existingByAiuser: null, existingByPhone: null }, deps.now()).ok) return rejected();
      const status = await deps.repository.commit(commit);
      if (status !== "linked" && status !== "already_linked") return rejected(503);
      const resultHeaders = headers(); resultHeaders.append("Set-Cookie", clearAiUserLinkIntent());
      return Response.json({ ok: true, status, assetsMerged: false, creditsGranted: false, administratorGranted: false }, { headers: resultHeaders });
    } catch { return rejected(503); }
  };
}
