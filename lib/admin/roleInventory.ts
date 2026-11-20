import {
  ADMIN_ROLES,
  type AdminRole,
  type UserProjection,
  type UserRoleRecord,
} from "./types";

// Bound the only free-text field so a stored display name cannot inflate the read projection.
const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * Read-only role inventory row. Deliberately excludes the account/user id,
 * tenant id and the granting administrator's principal id: the console already
 * exposes those through the main snapshot, and this projection must stay safe
 * for the independent P0.5 read-only boundary.
 */
export type AdminRoleInventoryEntry = Readonly<{
  role: AdminRole;
  displayName?: string;
  createdAt: string;
}>;

export type AdminRoleInventory = Readonly<{
  generatedAt: string;
  roles: AdminRoleInventoryEntry[];
}>;

function normalizedDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean) return undefined;
  return clean.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function normalizedCreatedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

/**
 * Pure projection over the existing `AdminRepository.listRoles()` records.
 * Malformed rows are dropped instead of guessed at, and only role, display
 * name (when the account is present) and creation time are emitted.
 */
export function projectAdminRoleInventory(
  roleRecords: readonly UserRoleRecord[],
  users: readonly UserProjection[],
  generatedAt: string,
): AdminRoleInventory {
  const displayNames = new Map<string, string>();
  for (const user of users) {
    if (typeof user?.userId !== "string" || !user.userId) continue;
    const displayName = normalizedDisplayName(user.displayName);
    if (displayName) displayNames.set(user.userId, displayName);
  }

  const roles: AdminRoleInventoryEntry[] = [];
  for (const record of roleRecords) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.userId !== "string" || !record.userId) continue;
    const role = record.role;
    if (
      typeof role !== "string"
      || !(ADMIN_ROLES as readonly string[]).includes(role)
    ) continue;
    const createdAt = normalizedCreatedAt(record.createdAt);
    if (!createdAt) continue;
    const displayName = displayNames.get(record.userId);
    roles.push({
      role: role as AdminRole,
      ...(displayName ? { displayName } : {}),
      createdAt,
    });
  }

  return { generatedAt, roles };
}
