import { NextResponse } from "next/server";

import { getAdminRepository } from "@/lib/admin/service";
import type { FixedBetaRuntimeConfig } from "@/lib/billing/fixedBetaPricing";
import {
  GENERATION_READINESS_SCOPE,
  isPlatformBillingEnabledValue,
  resolveGenerationReadiness,
  toPublicGenerationReadiness,
  unavailableGenerationReadiness,
  type GenerationReadiness,
  type GenerationReadinessQuote,
} from "@/lib/billing/generationReadiness";
import { quotePlatformOperation } from "@/lib/billing/service";
import { loadEngineConfig } from "@/lib/config";
import { assertProductionDatabaseGateReady } from "@/lib/production/databaseGate";
import { requireUser } from "@/lib/supabase/guard";
import { resolveLinkedPhoneForBilling } from "@/lib/billing/linkedBillingServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Only the fixed allowlist may leave this route. No identifiers, environment
 * values, raw errors, tokens, runtime model/config, or full price policy.
 */
const READINESS_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "Referrer-Policy": "no-referrer",
} as const;

function respond(readiness: GenerationReadiness): NextResponse {
  return NextResponse.json(toPublicGenerationReadiness(readiness), {
    status: 200,
    headers: READINESS_HEADERS,
  });
}

/**
 * GET /api/account/generation-readiness
 *
 * Read-only readiness visibility for platform-credit generation. This is NOT
 * activation and NOT authorization:
 * - it never reserves/settles credits, contacts a provider, or writes a row;
 * - `available: true` only means the service is ready, not that the balance is
 *   sufficient;
 * - generation must still enforce its own billing gate and credit checks.
 *
 * Auth/authorization failures are reported as unavailable projections (never
 * raw auth error bodies), so the notice can render a fixed safe reason without
 * exposing error details.
 *
 * Scope is intentionally limited to `story.start`. Other operations (for
 * example `story.scene`) are not assumed to be supported and must be checked
 * separately where they are used.
 */
export async function GET(): Promise<Response> {
  try {
    // Resolve the repository lazily. When billing is disabled this route must
    // not call the database or load engine configuration at all.
    let repository: ReturnType<typeof getAdminRepository> | undefined;
    const admin = () => (repository ??= getAdminRepository());

    const readiness = await resolveGenerationReadiness({
      // Exact string match. "1", "TRUE", whitespace, and unset are disabled.
      isBillingEnabled: () =>
        isPlatformBillingEnabledValue(
          process.env.AISTORY_PLATFORM_BILLING_ENABLED,
        ),

      authenticate: async () => {
        const auth = await requireUser({
          allowAnonymousWhenAuthDisabled: true,
        });
        // requireUser returns a NextResponse on auth failure. Never forward it
        // or expose its body through this projection.
        if (auth instanceof NextResponse) return null;
        if (auth.authType === "aiuser") {
          const linked = await resolveLinkedPhoneForBilling(auth.aiuser);
          return linked.state === "linked" ? { kind: "phone", userId: linked.phoneUserId } : null;
        }
        if (auth.authType === "phone" && auth.userId && auth.userId !== "anonymous") {
          return { kind: "phone", userId: auth.userId };
        }
        return null;
      },

      assertDatabaseGateReady: () =>
        assertProductionDatabaseGateReady("billing"),

      // Reads environment only; no provider request is made here.
      loadRuntimeConfig: loadEngineConfig,

      // Read-only account check. Availability means the service is ready; it
      // deliberately does NOT mean the balance is sufficient. No ledger write
      // or reservation happens here, so no balance read is needed.
      loadUser: (userId) => admin().getUser(userId),

      // Quote only. No reserve, settle, provider call, or credit grant.
      // `quotePlatformOperation` returns { publicQuote, policy, catalogEntry },
      // while readiness consumes only { estimatedCredits }. Extract the public
      // quote explicitly; casting the wrapper would hide the contract mismatch.
      quote: async (config): Promise<GenerationReadinessQuote> => {
        const { publicQuote } = await quotePlatformOperation(
          admin(),
          GENERATION_READINESS_SCOPE,
          // loadEngineConfig() supplies the runtime model bindings that the
          // billing service validates against the active price catalog.
          config as unknown as FixedBetaRuntimeConfig,
        );
        return { estimatedCredits: publicQuote.estimatedCredits };
      },
    });

    return respond(readiness);
  } catch {
    // Every failure becomes an unavailable projection with a fixed safe
    // message. Raw errors are never serialized.
    return respond(unavailableGenerationReadiness("service_unavailable"));
  }
}
