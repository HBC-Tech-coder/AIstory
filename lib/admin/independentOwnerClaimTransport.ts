import "server-only";
import type { IncomingMessage } from "node:http";

declare const ownerClaimBrand: unique symbol;
export type IndependentOwnerClaimProof = Readonly<{ [ownerClaimBrand]: true }>;
const proofs = new WeakSet<object>();

// Called ONLY by the dedicated loopback listener, never by a Next/proxy route.
// HTTP headers/JSON alone cannot mint this process-local transport capability.
export function inspectIndependentOwnerClaimSocket(request: IncomingMessage): IndependentOwnerClaimProof | undefined {
  const { remoteAddress, localAddress, localPort } = request.socket;
  if (!remoteAddress || !localAddress || !["127.0.0.1", "::1"].includes(remoteAddress)
    || !["127.0.0.1", "::1"].includes(localAddress) || !Number.isInteger(localPort) || !localPort) return;
  const host = localAddress === "::1" ? `[::1]:${localPort}` : `127.0.0.1:${localPort}`;
  if (request.headers.host !== host || request.rawHeaders.filter((_, i) => i % 2 === 0)
    .some(name => /^(forwarded|x-forwarded-.+|x-real-ip)$/i.test(name))) return;
  if (request.method !== "GET" && request.headers.origin !== `http://${host}`) return;
  if (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"]))) return;
  const proof = Object.freeze({}) as IndependentOwnerClaimProof;
  proofs.add(proof); return proof;
}

export function isIndependentOwnerClaimProof(value: unknown): value is IndependentOwnerClaimProof {
  return !!value && typeof value === "object" && proofs.has(value);
}
