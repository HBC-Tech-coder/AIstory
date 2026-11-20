import "server-only";

import { headers as nextHeaders } from "next/headers";
import {
  linghaoPassportV4ProductionModeRequested,
  linghaoPassportV4PublicEntryRequested,
} from "./linghaoPassportV4ProductionContract";
import {
  hasLinghaoPassportV4ProductCookieHeader,
} from "./linghaoPassportV4ProductionCookies";
import { loadLinghaoPassportV4ProductionMaterials } from "./linghaoPassportV4ProductionLoader";
import {
  LinghaoPassportV4ProductionServer,
  type LinghaoPassportV4ProductionAction,
} from "./linghaoPassportV4ProductionServer";
import {
  getLinghaoPassportV4Server,
  type LinghaoPassportV4Action,
} from "./linghaoPassportV4Server";
import type { LinghaoPassportV4ProductSessionRead } from "./linghaoPassportV4ProductionSession";

function unavailable(status = 404): Response {
  return Response.json(
    { error: "unavailable" },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export async function handleLinghaoPassportV4Request(
  action: LinghaoPassportV4Action,
  request: Request,
): Promise<Response> {
  if (!linghaoPassportV4ProductionModeRequested(process.env)) {
    return getLinghaoPassportV4Server().handle(action, request);
  }
  if (action === "draft") return unavailable();
  let materials;
  try {
    materials = await loadLinghaoPassportV4ProductionMaterials();
  } catch {
    materials = null;
  }
  if (!materials) {
    if (action === "capabilities") {
      return Response.json(
        { enabled: false, mode: "production", publicEntry: false },
        { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } },
      );
    }
    return unavailable(503);
  }
  try {
    return await new LinghaoPassportV4ProductionServer({
      materials,
      publicEntry: linghaoPassportV4PublicEntryRequested(process.env),
    }).handle(action as LinghaoPassportV4ProductionAction, request);
  } finally {
    materials.stateSealKey.fill(0);
  }
}

export async function readLinghaoPassportV4ProductSession(
  request?: Request,
): Promise<LinghaoPassportV4ProductSessionRead> {
  const input = request ?? new Request("https://play.hibcglobal.com", {
    headers: await nextHeaders(),
  });
  if (!hasLinghaoPassportV4ProductCookieHeader(input.headers.get("cookie"))) {
    return { state: "absent" };
  }
  if (!linghaoPassportV4ProductionModeRequested(process.env)) {
    return { state: "invalid" };
  }
  let materials;
  try {
    materials = await loadLinghaoPassportV4ProductionMaterials();
    if (!materials) return { state: "invalid" };
    return await new LinghaoPassportV4ProductionServer({
      materials,
      publicEntry: linghaoPassportV4PublicEntryRequested(process.env),
    }).readProductSession(input);
  } catch {
    return { state: "invalid" };
  } finally {
    materials?.stateSealKey.fill(0);
  }
}

export async function logoutLinghaoPassportV4ProductSession(
  request: Request,
  response: Response,
): Promise<boolean> {
  if (!hasLinghaoPassportV4ProductCookieHeader(request.headers.get("cookie"))) return true;
  if (!linghaoPassportV4ProductionModeRequested(process.env)) return false;
  let materials;
  try {
    materials = await loadLinghaoPassportV4ProductionMaterials();
    if (!materials) return false;
    const cookies = await new LinghaoPassportV4ProductionServer({
      materials,
      publicEntry: linghaoPassportV4PublicEntryRequested(process.env),
    }).revokeProductSessionForAccount(request);
    if (!cookies) return false;
    for (const value of cookies) response.headers.append("Set-Cookie", value);
    return true;
  } catch {
    return false;
  } finally {
    materials?.stateSealKey.fill(0);
  }
}
