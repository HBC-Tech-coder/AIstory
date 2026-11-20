import { NextResponse } from "next/server";

import { readPhoneUserSession } from "@/lib/auth/userSession";
import { requireUser } from "@/lib/supabase/guard";
import type { CredentialModality } from "@/lib/credentials/types";
import {
  HostedCredentialUnavailableError,
  inspectHostedCredentialFeature,
} from "@/lib/credentials/hosted/config";
import {
  createHostedCredential,
  deleteHostedCredential,
  listHostedCredentials,
  replaceHostedCredential,
  type HostedCredentialActor,
} from "@/lib/credentials/hosted/service";
import type { HostedCredentialProvider } from "@/lib/credentials/hosted/types";
import { ProductionDatabaseGateError } from "@/lib/production/databaseGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 12 * 1024;
const PROVIDERS = new Set<HostedCredentialProvider>([
  "openai",
  "openai_compatible",
  "dashscope",
  "runware",
  "stepfun",
]);
const CAPABILITIES = new Set<CredentialModality>([
  "text",
  "image",
  "vision",
  "tts",
  "video",
]);

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Vary: "Cookie",
    },
  });
}

function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HostedCredentialUnavailableError("identity_gate_unavailable", 403);
  }
  return parsed as Record<string, unknown>;
}

function capabilities(value: unknown): CredentialModality[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is CredentialModality =>
      typeof item === "string" && CAPABILITIES.has(item as CredentialModality),
  );
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function provider(value: unknown): HostedCredentialProvider {
  if (typeof value === "string" && PROVIDERS.has(value as HostedCredentialProvider)) {
    return value as HostedCredentialProvider;
  }
  throw new HostedCredentialUnavailableError("provider_allowlist_unavailable", 403);
}

async function actor(): Promise<HostedCredentialActor> {
  const auth = await requireUser();
  if (auth instanceof NextResponse || auth.authType !== "phone") {
    throw new HostedCredentialUnavailableError("identity_gate_unavailable", 401);
  }
  const session = await readPhoneUserSession();
  if (!session || session.version !== 2 || session.userId !== auth.userId) {
    throw new HostedCredentialUnavailableError("identity_gate_unavailable", 401);
  }
  return {
    userId: session.userId,
    tenantId: "platform",
    authType: "phone",
    verifiedAt: session.issuedAt,
  };
}

function safeError(error: unknown): NextResponse {
  if (error instanceof HostedCredentialUnavailableError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof ProductionDatabaseGateError) {
    return json({
      error: "托管凭据仓储尚未就绪。",
      code: "identity_gate_unavailable",
    }, 503);
  }
  return json({
    error: "托管凭据请求未完成。",
    code: "repository_unavailable",
  }, 503);
}

export async function GET(): Promise<Response> {
  const feature = inspectHostedCredentialFeature();
  if (!feature.enabled) {
    return json({ feature, authenticated: false, credentials: [] });
  }
  try {
    const currentActor = await actor();
    return json({
      feature,
      authenticated: true,
      credentials: await listHostedCredentials(currentActor),
    });
  } catch (error) {
    return safeError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return json({ error: "Forbidden" }, 403);
  try {
    const input = await body(request);
    const credential = await createHostedCredential({
      actor: await actor(),
      provider: provider(input.provider),
      capabilities: capabilities(input.capabilities),
      defaultFor: capabilities(input.defaultFor),
      plaintext: {
        apiKey: string(input.apiKey),
        baseUrl: string(input.baseUrl),
        model: string(input.model),
      },
      idempotencyKey: string(input.idempotencyKey),
      reason: string(input.reason),
    });
    return json({ ok: true, credential }, 201);
  } catch (error) {
    return safeError(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return json({ error: "Forbidden" }, 403);
  try {
    const input = await body(request);
    const credential = await replaceHostedCredential({
      actor: await actor(),
      credentialId: string(input.credentialId),
      capabilities: capabilities(input.capabilities),
      defaultFor: capabilities(input.defaultFor),
      plaintext: {
        apiKey: string(input.apiKey),
        baseUrl: string(input.baseUrl),
        model: string(input.model),
      },
      idempotencyKey: string(input.idempotencyKey),
      reason: string(input.reason),
    });
    return json({ ok: true, credential });
  } catch (error) {
    return safeError(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return json({ error: "Forbidden" }, 403);
  try {
    const input = await body(request);
    const credential = await deleteHostedCredential({
      actor: await actor(),
      credentialId: string(input.credentialId),
      idempotencyKey: string(input.idempotencyKey),
      reason: string(input.reason),
    });
    return json({ ok: true, credential });
  } catch (error) {
    return safeError(error);
  }
}

