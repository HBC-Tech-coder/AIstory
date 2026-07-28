import { NextRequest, NextResponse } from "next/server";

import { validateComfyUIProviderConfig } from "@/lib/providers/comfyui/validation";
import { requireUser } from "@/lib/supabase/guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  try {
    const value = await request.json();
    const result = validateComfyUIProviderConfig(value);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        issues: [{ path: "$", message: "请求必须是有效 JSON。" }],
      },
      { status: 400 },
    );
  }
}
