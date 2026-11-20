import "server-only";

import { randomUUID } from "node:crypto";

import {
  CoordinatorHmacError,
  signCoordinatorResponse,
  verifyCoordinatorRequest,
  type CoordinatorHmacKeyRing,
} from "./hmac";
import {
  parseCoordinatorRequest,
  parseCoordinatorRequestBytes,
} from "./protocol";
import {
  mapCoordinatorError,
  type GpuCoordinatorService,
} from "./service";
import type {
  CoordinatorErrorCode,
  CoordinatorResponseEnvelope,
  GpuCoordinatorOperation,
} from "./types";

export type CoordinatorTransportDependencies = {
  service: GpuCoordinatorService;
  keyRing: CoordinatorHmacKeyRing;
  replayGuard: {
    consume(
      keyId: string,
      nonce: string,
      expiresAt: Date,
      now: Date,
    ): Promise<boolean>;
  };
  now?: () => Date;
};

function hmacErrorStatus(error: CoordinatorHmacError): number {
  if (error.code === "request_stale") return 401;
  if (error.code === "hmac_replay_rejected") return 409;
  return 401;
}

export async function dispatchCoordinatorRequest(
  dependencies: CoordinatorTransportDependencies,
  input: {
    operation: GpuCoordinatorOperation;
    method: string;
    path: string;
    headers: Headers;
    body: Uint8Array;
  },
): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
  const now = dependencies.now?.() ?? new Date();
  let verified:
    | {
        keyId: string;
        requestId: string;
      }
    | undefined;
  try {
    verified = await verifyCoordinatorRequest({
      method: input.method,
      path: input.path,
      headers: input.headers,
      body: input.body,
      keyRing: dependencies.keyRing,
      replayGuard: dependencies.replayGuard,
      now,
    });
    const parsed = parseCoordinatorRequest(
      input.operation,
      parseCoordinatorRequestBytes(input.body),
    );
    const data = await dependencies.service.handle(input.operation, parsed, {
      operation: input.operation,
      requestId: verified.requestId,
      keyId: verified.keyId,
      now,
    });
    const sequence =
      "sequence" in parsed && typeof parsed.sequence === "number"
        ? parsed.sequence
        : 0;
    const envelope: CoordinatorResponseEnvelope = {
      protocolVersion: "1.0",
      requestId: verified.requestId,
      serverTime: now.toISOString(),
      sequence,
      ok: true,
      control: dependencies.service.control(),
      data,
    };
    const signed = signCoordinatorResponse({
      envelope,
      status: 200,
      path: input.path,
      key: dependencies.keyRing.current,
      now,
    });
    return { status: 200, ...signed };
  } catch (error) {
    if (!verified && error instanceof CoordinatorHmacError) {
      const body = new TextEncoder().encode(
        JSON.stringify({
          error: {
            code: error.code,
            correlationId: randomUUID(),
          },
        }),
      );
      return {
        status: hmacErrorStatus(error),
        headers: new Headers({
          "content-type": "application/json",
          "cache-control": "no-store",
        }),
        body,
      };
    }
    const mapped =
      error instanceof CoordinatorHmacError
        ? {
            code: error.code as CoordinatorErrorCode,
            retryable: false,
            status: hmacErrorStatus(error),
          }
        : mapCoordinatorError(error);
    const requestId = verified?.requestId ?? `rejected-${randomUUID()}`;
    const envelope: CoordinatorResponseEnvelope = {
      protocolVersion: "1.0",
      requestId,
      serverTime: now.toISOString(),
      sequence: 0,
      ok: false,
      control: dependencies.service.control(),
      error: {
        code: mapped.code,
        retryable: mapped.retryable,
        correlationId: randomUUID(),
      },
    };
    const signed = signCoordinatorResponse({
      envelope,
      status: mapped.status,
      path: input.path,
      key: dependencies.keyRing.current,
      now,
    });
    return { status: mapped.status, ...signed };
  }
}
