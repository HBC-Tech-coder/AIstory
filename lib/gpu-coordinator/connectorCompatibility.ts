import {
  CENTRAL_RECONCILE_AUTHORITATIVE_STATES,
  CONNECTOR_HEARTBEAT_REQUEST_STATES,
  CONNECTOR_RECONCILE_REQUEST_STATES,
  type ConnectorNetworkPosture,
  type ConnectorRegistrationRequest,
} from "./types";

export const GPU_CONNECTOR_PRODUCTION_NETWORK_ENV =
  "AISTORY_CONNECTOR_ENABLE_PRODUCTION_NETWORK" as const;
export const GPU_CONNECTOR_LAN_LAB_NETWORK_ENV =
  "AISTORY_CONNECTOR_ENABLE_LAN_LAB_NETWORK" as const;

export const GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV =
  "AISTORY_GPU_LAN_LAB_EXPECTED_CONNECTOR_RELEASE_SHA256" as const;
export const GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV =
  "AISTORY_GPU_LAN_LAB_EXPECTED_CONNECTOR_BUILD_SHA256" as const;
export const GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV =
  "AISTORY_GPU_LAN_LAB_EXPECTED_CAPABILITY_DIGEST_SHA256" as const;
export const GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV =
  "AISTORY_GPU_LAN_LAB_EXPECTED_CENTRAL_CONTRACT_SHA256" as const;
export const GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV =
  "AISTORY_GPU_LAN_LAB_EXPECTED_RUNNER_MODE" as const;

export const GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE = Object.freeze({
  productionNetworkEnabled: false,
  lanLabNetworkEnabled: true,
  runnerMode: "no_work_only",
} satisfies ConnectorNetworkPosture);

export type GpuConnectorRuntimeBinding = {
  expectedBuildSha256: string;
  expectedReleaseSha256: string;
  expectedCapabilityDigestSha256: string;
  expectedCentralContractSha256: string;
  expectedNetworkPosture: ConnectorNetworkPosture;
};

export const GPU_CONNECTOR_COMPATIBILITY_CONTRACT = Object.freeze({
  schemaVersion: "aistory-gpu-connector-compatibility-v1",
  firstHeartbeat: "idle",
  heartbeatRequestStates: [...CONNECTOR_HEARTBEAT_REQUEST_STATES],
  reconcileRequestStates: [...CONNECTOR_RECONCILE_REQUEST_STATES],
  reconcileResponseAuthoritativeStates: [
    ...CENTRAL_RECONCILE_AUTHORITATIVE_STATES,
  ],
  connectorNetwork: {
    productionEnv: GPU_CONNECTOR_PRODUCTION_NETWORK_ENV,
    lanLabEnv: GPU_CONNECTOR_LAN_LAB_NETWORK_ENV,
    defaults: {
      productionNetworkEnabled: false,
      lanLabNetworkEnabled: false,
    },
    mutuallyExclusive: true,
  },
  requiredInitialPosture: { ...GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE },
  noWorkOnlyFirstGate: true,
});

function readOwnData(
  value: unknown,
  key: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return { ok: false };
    }
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

function readPosture(value: unknown): ConnectorNetworkPosture | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 3 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          ![
            "productionNetworkEnabled",
            "lanLabNetworkEnabled",
            "runnerMode",
          ].includes(key),
      )
    ) {
      return undefined;
    }
    const production = readOwnData(value, "productionNetworkEnabled");
    const lab = readOwnData(value, "lanLabNetworkEnabled");
    const runner = readOwnData(value, "runnerMode");
    if (
      !production.ok ||
      !lab.ok ||
      !runner.ok ||
      production.value !== false ||
      lab.value !== true ||
      !["no_work_only", "foreground_once"].includes(String(runner.value))
    ) {
      return undefined;
    }
    return {
      productionNetworkEnabled: false,
      lanLabNetworkEnabled: true,
      runnerMode: runner.value as ConnectorNetworkPosture["runnerMode"],
    };
  } catch {
    return undefined;
  }
}

function postureEquals(left: unknown, right: unknown): boolean {
  const leftPosture = readPosture(left);
  const rightPosture = readPosture(right);
  return Boolean(
    leftPosture &&
      rightPosture &&
      leftPosture.productionNetworkEnabled ===
        rightPosture.productionNetworkEnabled &&
      leftPosture.lanLabNetworkEnabled ===
        rightPosture.lanLabNetworkEnabled &&
      leftPosture.runnerMode === rightPosture.runnerMode,
  );
}

export function registrationMatchesRuntimeBinding(
  registration: ConnectorRegistrationRequest,
  binding: GpuConnectorRuntimeBinding,
): "match" | "identity_mismatch" | "posture_mismatch" {
  if (
    registration.buildSha256 !== binding.expectedBuildSha256 ||
    registration.releaseSha256 !== binding.expectedReleaseSha256 ||
    registration.capabilityDigestSha256 !==
      binding.expectedCapabilityDigestSha256 ||
    registration.centralContractSha256 !==
      binding.expectedCentralContractSha256
  ) {
    return "identity_mismatch";
  }
  return postureEquals(
    registration.networkPosture,
    binding.expectedNetworkPosture,
  )
    ? "match"
    : "posture_mismatch";
}

export function storedConnectorMatchesRuntimeBinding(
  connector: unknown,
  binding: GpuConnectorRuntimeBinding,
): boolean {
  const build = readOwnData(connector, "buildSha256");
  const release = readOwnData(connector, "releaseSha256");
  const capability = readOwnData(connector, "capabilityDigestSha256");
  const central = readOwnData(connector, "centralContractSha256");
  const posture = readOwnData(connector, "networkPosture");
  return Boolean(
    build.ok &&
      build.value === binding.expectedBuildSha256 &&
      release.ok &&
      release.value === binding.expectedReleaseSha256 &&
      capability.ok &&
      capability.value === binding.expectedCapabilityDigestSha256 &&
      central.ok &&
      central.value === binding.expectedCentralContractSha256 &&
      posture.ok &&
      postureEquals(posture.value, binding.expectedNetworkPosture),
  );
}
