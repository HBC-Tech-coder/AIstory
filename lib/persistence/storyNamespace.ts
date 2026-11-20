const ACTIVE_STORY_NAMESPACE_KEY = "aistory:active-story-namespace:v1";

export const ANONYMOUS_STORY_NAMESPACE = "anonymous";

export function isStableAccountNamespace(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function activeStoryNamespace(): string {
  if (typeof window === "undefined") return ANONYMOUS_STORY_NAMESPACE;
  try {
    const value = window.sessionStorage.getItem(ACTIVE_STORY_NAMESPACE_KEY);
    return isStableAccountNamespace(value)
      ? value
      : ANONYMOUS_STORY_NAMESPACE;
  } catch {
    return ANONYMOUS_STORY_NAMESPACE;
  }
}

export function setActiveStoryNamespace(userId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (isStableAccountNamespace(userId)) {
      window.sessionStorage.setItem(ACTIVE_STORY_NAMESPACE_KEY, userId);
    } else {
      window.sessionStorage.removeItem(ACTIVE_STORY_NAMESPACE_KEY);
    }
    window.localStorage.removeItem(ACTIVE_STORY_NAMESPACE_KEY);
    window.dispatchEvent(new Event("aistory:story-namespace-changed"));
  } catch {
    // Browser persistence remains best-effort; credentials are never involved.
  }
}

export function storyStorageKey(namespace: string, storyId: string): string {
  return `${namespace}::${storyId}`;
}
