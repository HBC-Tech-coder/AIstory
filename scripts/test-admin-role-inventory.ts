import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { projectAdminRoleInventory } from "../lib/admin/roleInventory";
import { handleAdminRoleInventoryGet } from "../lib/admin/roleInventoryHandler";
import type {
  AdminActor,
  AdminRole,
  UserProjection,
  UserRoleRecord,
} from "../lib/admin/types";

const GENERATED_AT = "2026-02-01T00:00:00.000Z";
const PRINCIPAL_MARKER = "PRINCIPAL_MARKER_ID";
const TENANT_MARKER = "TENANT_MARKER";
const SECRET_MARKER = "SECRET_MARKER";
const COOKIE_MARKER = "COOKIE_MARKER";
const SUBJECT_MARKER = "SUBJECT_MARKER";
const ALLOWED_ENTRY_KEYS = ["role", "displayName", "createdAt"];

const actor: AdminActor = {
  userId: "local-admin",
  roles: ["super_admin"],
  mode: "local",
};

function makeUser(
  userId: string,
  displayName: string,
): UserProjection {
  return {
    userId,
    tenantId: TENANT_MARKER,
    displayName,
    status: "active",
    userType: "staff",
    tags: [],
    createdAt: GENERATED_AT,
  };
}

function makeRole(
  userId: string,
  role: AdminRole,
  overrides: Partial<UserRoleRecord> = {},
): UserRoleRecord {
  return {
    userId,
    tenantId: TENANT_MARKER,
    role,
    createdAt: GENERATED_AT,
    createdBy: PRINCIPAL_MARKER,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Pure projection: minimal fields, validation, and redaction.
// ---------------------------------------------------------------------------
{
  const users: UserProjection[] = [
    makeUser("SUBJECT_ONE", "  审计 管理员  "),
    makeUser("SUBJECT_TWO", ""),
    makeUser("SUBJECT_THREE", "x".repeat(200)),
    makeUser("SUBJECT_FOUR", "控制\u0000字符\n名字"),
  ];
  const roleRecords: UserRoleRecord[] = [
    makeRole("SUBJECT_ONE", "super_admin", {
      createdAt: "2026-01-02T03:04:05.000Z",
    }),
    makeRole("SUBJECT_TWO", "ops"),
    makeRole("SUBJECT_THREE", "moderator"),
    makeRole("SUBJECT_FOUR", "support"),
    makeRole("SUBJECT_MISSING", "finance"),
    // Hostile / malformed rows that must never surface.
    {
      ...makeRole("SUBJECT_ONE", "super_admin"),
      role: "root" as AdminRole,
    },
    {
      ...makeRole("", "support"),
    },
    {
      ...makeRole("SUBJECT_FIVE", "analyst", { createdAt: "not-a-date" }),
    },
    {
      ...makeRole("SUBJECT_SIX", "ops"),
      credential: SECRET_MARKER,
      cookie: COOKIE_MARKER,
      subject: SUBJECT_MARKER,
    } as UserRoleRecord,
  ];

  const inventory = projectAdminRoleInventory(roleRecords, users, GENERATED_AT);
  assert.equal(inventory.generatedAt, GENERATED_AT);
  assert.equal(inventory.roles.length, 6);

  const first = inventory.roles[0];
  assert.deepEqual(first, {
    role: "super_admin",
    displayName: "审计 管理员",
    createdAt: "2026-01-02T03:04:05.000Z",
  });

  const withoutName = inventory.roles[1];
  assert.equal(withoutName?.role, "ops");
  assert.equal("displayName" in (withoutName ?? {}), false);

  const truncated = inventory.roles[2];
  assert.equal(truncated?.displayName, "x".repeat(80));

  const sanitized = inventory.roles[3];
  assert.equal(sanitized?.displayName, "控制字符名字");

  const missingUser = inventory.roles[4];
  assert.equal(missingUser?.role, "finance");
  assert.equal("displayName" in (missingUser ?? {}), false);

  for (const entry of inventory.roles) {
    assert.ok(
      Object.keys(entry).every((key) => ALLOWED_ENTRY_KEYS.includes(key)),
      `unexpected inventory key in ${JSON.stringify(entry)}`,
    );
  }

  const serialized = JSON.stringify(inventory);
  for (const forbidden of [
    PRINCIPAL_MARKER,
    TENANT_MARKER,
    SECRET_MARKER,
    COOKIE_MARKER,
    SUBJECT_MARKER,
    "SUBJECT_ONE",
    "createdBy",
    "tenantId",
    "userId",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `inventory leaked ${forbidden}`,
    );
  }

  // Invalid input containers must be dropped, not thrown on.
  const hostileInput = projectAdminRoleInventory(
    [null, undefined, "row"] as unknown as UserRoleRecord[],
    [null, undefined] as unknown as UserProjection[],
    GENERATED_AT,
  );
  assert.deepEqual(hostileInput.roles, []);
}

// ---------------------------------------------------------------------------
// 2. Handler boundary: authorization before repository, no-store, fail-closed.
// ---------------------------------------------------------------------------
function fakeRepository(
  roleRecords: UserRoleRecord[],
  users: UserProjection[],
) {
  return {
    listRoles: async () => roleRecords,
    listUsers: async () => users,
  };
}

{
  // Unauthorized: the repository must never be loaded.
  let repositoryLoaded = 0;
  const denied = await handleAdminRoleInventoryGet({
    authorize: async () =>
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    getRepository: async () => {
      repositoryLoaded += 1;
      throw new Error("repository must not load for an unauthorized actor");
    },
    now: () => GENERATED_AT,
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.equal(repositoryLoaded, 0);
  assert.deepEqual(await denied.json(), { error: "Forbidden" });

  // Authorized super admin sees the safe projection with no-store.
  let seenActor: AdminActor | undefined;
  const allowed = await handleAdminRoleInventoryGet({
    authorize: async () => actor,
    getRepository: async (received) => {
      seenActor = received;
      return fakeRepository(
        [makeRole("SUBJECT_ONE", "super_admin")],
        [makeUser("SUBJECT_ONE", "审计管理员")],
      );
    },
    now: () => GENERATED_AT,
  });
  assert.equal(allowed.status, 200);
  assert.equal(seenActor, actor);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  const allowedBody = (await allowed.json()) as {
    generatedAt: string;
    roles: Array<Record<string, unknown>>;
  };
  assert.equal(allowedBody.generatedAt, GENERATED_AT);
  assert.deepEqual(allowedBody.roles, [
    {
      role: "super_admin",
      displayName: "审计管理员",
      createdAt: GENERATED_AT,
    },
  ]);

  // The independent P0.5 principal must never reach the repository. The real
  // route relies on `requireAdmin(["super_admin"])`, whose default behavior
  // rejects `mode: "independent"` unless the caller opts in with
  // `allowIndependent`; this mirrors that gate and asserts the handler stops
  // before any control-plane read.
  const independentActor: AdminActor = {
    userId: "independent-admin",
    roles: ["super_admin"],
    mode: "independent",
  };
  let independentRepositoryLoaded = 0;
  const independentDenied = await handleAdminRoleInventoryGet({
    authorize: async () =>
      independentActor.mode === "independent"
        ? NextResponse.json({ error: "Forbidden" }, { status: 403 })
        : independentActor,
    getRepository: async () => {
      independentRepositoryLoaded += 1;
      throw new Error("an independent actor must not reach the repository");
    },
    now: () => GENERATED_AT,
  });
  assert.equal(independentDenied.status, 403);
  assert.equal(independentDenied.headers.get("cache-control"), "no-store");
  assert.deepEqual(await independentDenied.json(), { error: "Forbidden" });
  assert.equal(independentRepositoryLoaded, 0);

  // Repository failure: fail closed with a generic body and no internal detail.
  const failed = await handleAdminRoleInventoryGet({
    authorize: async () => actor,
    getRepository: async () => {
      throw new Error("INTERNAL_DB_DETAIL_MARKER");
    },
    now: () => GENERATED_AT,
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  const failedText = await failed.text();
  assert.equal(failedText.includes("INTERNAL_DB_DETAIL_MARKER"), false);
  assert.deepEqual(JSON.parse(failedText), {
    error: "管理员角色数据暂时不可用。",
  });

  // Authorization failure itself also fails closed without leaking.
  const authFailed = await handleAdminRoleInventoryGet({
    authorize: async () => {
      throw new Error("AUTH_INTERNAL_MARKER");
    },
    getRepository: async () => {
      throw new Error("should not load");
    },
    now: () => GENERATED_AT,
  });
  assert.equal(authFailed.status, 503);
  assert.equal(authFailed.headers.get("cache-control"), "no-store");
  assert.equal((await authFailed.text()).includes("AUTH_INTERNAL_MARKER"), false);
}

/**
 * Collect the runtime export names declared by a module. Route modules are
 * only allowed to export segment config and HTTP methods, so the boundary test
 * pins the exact, complete set instead of relying on a denylist alone.
 */
function exportsOf(source: string): string[] {
  const names = new Set<string>();
  const declaration =
    /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm;
  for (
    let match = declaration.exec(source);
    match !== null;
    match = declaration.exec(source)
  ) {
    if (match[1]) names.add(match[1]);
  }
  const named = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm;
  for (
    let match = named.exec(source);
    match !== null;
    match = named.exec(source)
  ) {
    for (const part of (match[1] ?? "").split(",")) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const alias = cleaned.split(/\s+as\s+/);
      names.add((alias[1] ?? alias[0] ?? "").trim());
    }
  }
  if (/^\s*export\s+(?:type\s+)?\*\s+from/m.test(source)) names.add("*");
  return [...names];
}

// ---------------------------------------------------------------------------
// 3. Source boundary: pinned against future regressions.
// ---------------------------------------------------------------------------
{
  const root = process.cwd();
  const routeSource = await readFile(
    path.join(root, "app", "api", "admin", "roles", "route.ts"),
    "utf8",
  );
  assert.match(
    routeSource,
    /requireAdmin\(\s*\["super_admin"\]\s*\)/,
    "the real gate must use the default super-admin-only authorization",
  );
  assert.doesNotMatch(
    routeSource,
    /allowIndependent/,
    "the real roles gate must not opt into independent authorization",
  );
  assert.match(routeSource, /export async function GET/);
  assert.doesNotMatch(
    routeSource,
    /export async function (POST|PUT|PATCH|DELETE)/,
    "the roles route must stay read-only",
  );
  assert.doesNotMatch(
    routeSource,
    /addRole|appendAudit|applyAdminMutationAtomically|adjustCredits/,
    "the roles route must not call mutation paths",
  );
  assert.match(
    routeSource,
    /handleAdminRoleInventoryGet\s*\(/,
    "the GET route must delegate to the extracted handler",
  );
  const routeExports = exportsOf(routeSource);
  assert.deepEqual(
    routeExports.sort(),
    ["GET", "runtime"],
    "the route module may only export the runtime segment and GET",
  );
  for (const illegalExport of [
    "projectAdminRoleInventory",
    "handleAdminRoleInventoryGet",
    "AdminRoleInventory",
    "AdminRoleInventoryEntry",
    "AdminRoleInventoryRouteDeps",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ]) {
    assert.equal(
      routeExports.includes(illegalExport),
      false,
      `illegal route export: ${illegalExport}`,
    );
  }

  const handlerSource = await readFile(
    path.join(root, "lib", "admin", "roleInventoryHandler.ts"),
    "utf8",
  );
  assert.match(handlerSource, /"Cache-Control": "no-store"/);
  assert.match(
    handlerSource,
    /"管理员角色数据暂时不可用。"/,
    "the sanitized 503 body must be preserved",
  );
  assert.doesNotMatch(
    handlerSource,
    /addRole|appendAudit|applyAdminMutationAtomically|adjustCredits/,
    "the extracted handler must not call mutation paths",
  );
  const authorizeIndex = handlerSource.indexOf("deps.authorize()");
  const repositoryIndex = handlerSource.indexOf("deps.getRepository(");
  assert.ok(authorizeIndex >= 0, "authorization call missing");
  assert.ok(
    repositoryIndex > authorizeIndex,
    "authorization must run before the repository is loaded",
  );

  const projectionSource = await readFile(
    path.join(root, "lib", "admin", "roleInventory.ts"),
    "utf8",
  );
  assert.match(
    projectionSource,
    /export function projectAdminRoleInventory/,
    "the projection helper must be exported for tests",
  );
  assert.doesNotMatch(
    projectionSource,
    /requireAdmin|getAdminRepositoryForActor|deps\.authorize/,
    "the projection helper must stay pure and side-effect free",
  );
  assert.doesNotMatch(
    projectionSource,
    /addRole|appendAudit|applyAdminMutationAtomically|adjustCredits/,
    "the projection helper must not call mutation paths",
  );

  const panelSource = await readFile(
    path.join(root, "components", "AdminRoleManagementPanel.tsx"),
    "utf8",
  );
  assert.match(panelSource, /\/api\/admin\/roles/);
  assert.doesNotMatch(panelSource, /\/api\/admin\/actions/);
  assert.doesNotMatch(
    panelSource,
    /method:\s*"(POST|PUT|PATCH|DELETE)"/,
    "the panel must not issue mutations",
  );

  const consoleSource = await readFile(
    path.join(root, "app", "admin", "AdminConsole.tsx"),
    "utf8",
  );
  assert.match(consoleSource, /AdminRoleManagementPanel/);
  assert.match(consoleSource, /id:\s*"roles"/);
  assert.match(consoleSource, /tab === "roles"/);
  assert.match(
    consoleSource,
    /canViewRoleInventory = actor\.mode !== "independent"/,
    "the role inventory tab must be hidden for independent actors",
  );
  assert.match(
    consoleSource,
    /tab === "roles" && canViewRoleInventory/,
    "the role inventory panel must stay behind the non-independent gate",
  );
  assert.match(consoleSource, /actor\.roles\.includes\("super_admin"\)/);
  // Independent navigation stays overview/users only.
  assert.match(
    consoleSource,
    /item\.id === "overview" \|\| item\.id === "users"/,
  );

  // The default `requireAdmin` behavior (used by the real gate) rejects an
  // independent actor unless authorization explicitly opts in.
  const securitySource = await readFile(
    path.join(root, "lib", "admin", "security.ts"),
    "utf8",
  );
  assert.match(
    securitySource,
    /actor\.mode === "independent" && !options\?\.allowIndependent/,
    "requireAdmin must reject independent actors by default",
  );
}

console.log("admin role inventory tests passed");
