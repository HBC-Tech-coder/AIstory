import type { SceneRequest } from "@infiplot/types";
import { NextResponse } from "next/server";

import { loadEngineConfig } from "@/lib/config";
import {
  getSpeculativeBranchContext,
  getSpeculativeBranchMetrics,
  getSpeculativePolicy,
  cancelQueuedSpeculativeTask,
  promoteSpeculativeTask,
} from "@/lib/engine/speculativeBranchCache";
import { authorizeCredentialAccess } from "@/lib/credentials/serverPolicy";
import { requireUser } from "@/lib/supabase/guard";
import { resolveLinkedPhoneForBilling } from "@/lib/billing/linkedBillingServer";
import type { AiUserLinkedBillingPhoneUserId } from "@/lib/auth/aiUserLinkedBillingRepository";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({
    policy: getSpeculativePolicy(),
    metrics: getSpeculativeBranchMetrics(),
  });
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  let body: SceneRequest & { command?: "promote" | "cancel" };
  try {
    body = (await req.json()) as SceneRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.session || body.speculation?.mode !== "foreground") {
    return NextResponse.json(
      { error: "foreground speculation with session is required" },
      { status: 400 },
    );
  }
  let verifiedLinkedPhoneUserId: AiUserLinkedBillingPhoneUserId | undefined;
  if (auth.authType === "aiuser") {
    try {
      const linked = await resolveLinkedPhoneForBilling(auth.aiuser);
      if (linked.state === "linked") verifiedLinkedPhoneUserId = linked.phoneUserId;
    } catch {
      return NextResponse.json({ error: "关联账户计费暂不可用。", code: "LINKED_BILLING_UNAVAILABLE" },
        { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
  const credentialAccess = authorizeCredentialAccess({
    requestedMode: "platform_managed",
    hasByok: false,
    userId: auth.userId,
    authType: auth.authType,
    verifiedLinkedPhoneUserId,
  });
  if (!credentialAccess.allowed) {
    return NextResponse.json(
      { error: credentialAccess.message, code: credentialAccess.code },
      { status: credentialAccess.status },
    );
  }

  const context = getSpeculativeBranchContext(
    body.session,
    loadEngineConfig(),
    body.speculation,
  );
  if (!context) {
    return NextResponse.json({ promoted: false, reason: "no-cache-key" });
  }
  if (body.command === "cancel") {
    return NextResponse.json({
      cancelled: cancelQueuedSpeculativeTask(context.keys.key),
      key: context.keys.key.slice(0, 16),
    });
  }
  return NextResponse.json({
    promoted: promoteSpeculativeTask(context.keys.key),
    key: context.keys.key.slice(0, 16),
  });
}
