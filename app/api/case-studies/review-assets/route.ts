import { NextResponse } from "next/server";

import {
  CASE_REVIEW_DECISIONS,
  readCaseReviewSnapshot,
  updateCaseReviewDecision,
  type CaseReviewDecision,
} from "@/lib/case-studies/reviewAssets";
import {
  isLoopbackReadRequest,
  isTrustedLoopbackMutationRequest,
} from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    return NextResponse.json({
      ok: true,
      data: await readCaseReviewSnapshot(),
    });
  } catch {
    return NextResponse.json(
      { error: "本地案例审核清单暂不可用" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  if (!isTrustedLoopbackMutationRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const body = (await request.json()) as {
      itemId?: unknown;
      decision?: unknown;
      note?: unknown;
    };
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const decision = body.decision as CaseReviewDecision;
    const note = typeof body.note === "string" ? body.note : "";
    if (
      !itemId
      || !CASE_REVIEW_DECISIONS.includes(decision)
      || note.length > 500
    ) {
      return NextResponse.json({ error: "审核参数无效" }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      data: await updateCaseReviewDecision({ itemId, decision, note }),
    });
  } catch {
    return NextResponse.json({ error: "审核状态更新失败" }, { status: 400 });
  }
}

