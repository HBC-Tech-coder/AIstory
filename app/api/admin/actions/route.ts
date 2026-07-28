import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/security";
import {
  addAdminRole,
  adjustCredits,
  buildAdminSnapshot,
  getAdminRepository,
  previewCreditGrant,
  publishBrandingVersion,
  saveBrandingDraft,
  saveBillingPolicy,
  saveChannelApplication,
  saveDomainBinding,
  savePaymentMetadata,
  savePlatformProviderMetadata,
  updateUserStatus,
} from "@/lib/admin/service";
import type {
  AdminRole,
  BillingPolicy,
  ChannelApp,
  DomainBinding,
  PaymentProviderConfig,
  PlatformBranding,
  PlatformProviderConfig,
} from "@/lib/admin/types";

export const runtime = "nodejs";

type AdminAction =
  | {
      action: "credit.adjust";
      userId: string;
      amount: number;
      reason: string;
      idempotencyKey: string;
    }
  | {
      action: "user.update";
      userId: string;
      status: "active" | "frozen" | "deleted";
      tags: string[];
      reason: string;
    }
  | {
      action: "role.add";
      userId: string;
      tenantId: string;
      role: AdminRole;
      reason: string;
    }
  | { action: "credit.batch_preview"; amount: number }
  | {
      action: "billing.policy.save";
      policy: Omit<BillingPolicy, "updatedAt" | "updatedBy">;
      reason: string;
    }
  | { action: "branding.preview"; branding: PlatformBranding }
  | { action: "branding.publish"; versionId: string; reason: string }
  | { action: "payment.save"; config: PaymentProviderConfig; reason: string }
  | { action: "provider.save"; config: PlatformProviderConfig; reason: string }
  | {
      action: "domain.save";
      binding: Omit<
        DomainBinding,
        | "verificationStatus"
        | "dnsStatus"
        | "certificateStatus"
        | "infrastructureApplied"
        | "createdAt"
        | "updatedAt"
      >;
      reason: string;
    }
  | { action: "channel.save"; app: ChannelApp; reason: string };

export async function POST(request: Request): Promise<Response> {
  const actor = await requireAdmin([
    "super_admin",
    "ops",
    "finance",
  ]);
  if (actor instanceof NextResponse) return actor;
  let body: AdminAction;
  try {
    body = await request.json() as AdminAction;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const repository = getAdminRepository();
  const requestId = request.headers.get("x-request-id") || randomUUID();
  try {
    let result: unknown;
    switch (body.action) {
      case "credit.adjust":
        result = await adjustCredits(repository, actor, {
          ...body,
          requestId,
        });
        break;
      case "user.update":
        result = await updateUserStatus(repository, actor, {
          ...body,
          requestId,
        });
        break;
      case "role.add":
        result = await addAdminRole(repository, actor, {
          ...body,
          requestId,
        });
        break;
      case "credit.batch_preview":
        result = await previewCreditGrant(repository, body.amount);
        break;
      case "billing.policy.save":
        result = await saveBillingPolicy(
          repository,
          actor,
          body.policy,
          body.reason,
          requestId,
        );
        break;
      case "branding.preview":
        result = await saveBrandingDraft(
          repository,
          actor,
          body.branding,
          requestId,
        );
        break;
      case "branding.publish":
        result = await publishBrandingVersion(
          repository,
          actor,
          body.versionId,
          body.reason,
          requestId,
        );
        break;
      case "payment.save":
        await savePaymentMetadata(
          repository,
          actor,
          body.config,
          body.reason,
          requestId,
        );
        result = { ok: true };
        break;
      case "provider.save":
        await savePlatformProviderMetadata(
          repository,
          actor,
          body.config,
          body.reason,
          requestId,
        );
        result = { ok: true };
        break;
      case "domain.save":
        result = await saveDomainBinding(
          repository,
          actor,
          body.binding,
          body.reason,
          requestId,
        );
        break;
      case "channel.save":
        await saveChannelApplication(
          repository,
          actor,
          body.app,
          body.reason,
          requestId,
        );
        result = { ok: true };
        break;
      default:
        return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }
    return NextResponse.json({
      result,
      snapshot: await buildAdminSnapshot(repository),
      requestId,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action failed", requestId },
      { status: 400 },
    );
  }
}
