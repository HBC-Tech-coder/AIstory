import "server-only";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IndependentAdminPrincipalServerOptions } from "./independentPrincipalServer";

// Historical entrypoint retained as a fail-closed tombstone. Pending activation
// v2 uses the normal HTTPS login/password-change routes, never a second listener.
export function createIndependentOwnerClaimHandler(
  _options: IndependentAdminPrincipalServerOptions = {},
  _handlers?: unknown,
) {
  void _options; void _handlers;
  return async (_request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.writeHead(410, { "Cache-Control": "no-store", "Content-Type": "application/json" });
    response.end('{"error":"Owner claim entrypoint is superseded."}');
  };
}
