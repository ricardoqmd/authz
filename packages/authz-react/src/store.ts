import type { AuthorizationContext, ContextSession, ContextSessionState } from "@ricardoqmd/authz-context";
import type { AuthorizationSession, AuthorizationState, PermissionEntry } from "@ricardoqmd/authz-core";

/**
 * Where the provider is, as one flat status for both kinds of session.
 *
 * A screen asks the same question whether or not the application has contexts, so a session without
 * contexts is shown in the same shape as one with them: `CHOOSING_CONTEXT` and `NO_CONTEXTS` simply
 * never occur for it.
 */
export type AuthzStatus =
  | "LOADING"
  | "CHOOSING_CONTEXT"
  | "NO_CONTEXTS"
  | "NO_ACCESS_IN_APP"
  | "READY"
  | "UNAVAILABLE";

export interface AuthzSnapshot {
  readonly status: AuthzStatus;
  /** The active context, while one is entered. Absent for a session without contexts. */
  readonly contextId?: string;
  /**
   * The contexts as of the last listing, for a picker: what `lastListedContexts()` returns, and an
   * empty list when it returns none. Always empty for a session without contexts.
   */
  readonly contexts: readonly AuthorizationContext[];
  /** The menu. Empty in every status but `READY`. */
  readonly permissions: readonly PermissionEntry[];
}

/**
 * What the hooks read: the snapshot, and the stretch of `READY` it belongs to.
 *
 * `stretch` changes every time the session leaves `READY`, so an answer asked for during one stretch
 * can be told apart from the next one even when a screen never renders the status in between.
 */
export interface StoreView {
  readonly snapshot: AuthzSnapshot;
  readonly stretch: number;
}

export interface SessionStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getView: () => StoreView;
}

const NO_CONTEXTS: readonly AuthorizationContext[] = Object.freeze([]);
const NO_PERMISSIONS: readonly PermissionEntry[] = Object.freeze([]);

function isContextSession(
  session: AuthorizationSession | ContextSession,
): session is ContextSession {
  return "selectContext" in session;
}

function fromPermissions(
  state: AuthorizationState,
): Pick<AuthzSnapshot, "status" | "permissions"> {
  switch (state.status) {
    case "READY":
      return { status: "READY", permissions: state.permissions };
    case "NO_ACCESS_IN_APP":
    case "UNAVAILABLE":
      return { status: state.status, permissions: NO_PERMISSIONS };
    default:
      return { status: "LOADING", permissions: NO_PERMISSIONS };
  }
}

function fromContexts(
  state: ContextSessionState,
): Pick<AuthzSnapshot, "status" | "permissions" | "contextId"> {
  switch (state.status) {
    case "IN_CONTEXT":
      return { ...fromPermissions(state.permissions), contextId: state.contextId };
    case "NO_ACCESS_IN_APP":
      return { status: "NO_ACCESS_IN_APP", permissions: NO_PERMISSIONS, contextId: state.contextId };
    case "CHOOSING_CONTEXT":
    case "NO_CONTEXTS":
    case "UNAVAILABLE":
      return { status: state.status, permissions: NO_PERMISSIONS };
    default:
      return { status: "LOADING", permissions: NO_PERMISSIONS };
  }
}

function snapshotOf(session: AuthorizationSession | ContextSession): AuthzSnapshot {
  if (!isContextSession(session)) {
    return { ...fromPermissions(session.getState()), contexts: NO_CONTEXTS };
  }
  // The list comes from the session and from nowhere else. The state carries it only while there is
  // something to choose; `lastListedContexts()` still holds it once a context is entered.
  const listed = session.lastListedContexts();
  return { ...fromContexts(session.getState()), contexts: listed ?? NO_CONTEXTS };
}

function sameElements<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((element, index) => element === b[index]);
}

function sameSnapshot(a: AuthzSnapshot, b: AuthzSnapshot): boolean {
  return (
    a.status === b.status &&
    a.contextId === b.contextId &&
    sameElements(a.contexts, b.contexts) &&
    sameElements(a.permissions, b.permissions)
  );
}

/**
 * The bridge between a session and `useSyncExternalStore`.
 *
 * **`getView` returns the same object until the session publishes a state that differs from the one
 * held.** React calls it on every render and compares the result by identity; a new object on every
 * call makes it render again, forever. A context session publishes a new object even for an equal
 * state, and `lastListedContexts()` returns a new array on every call, so the comparison is by the
 * elements, not by the containers.
 */
export function createSessionStore(session: AuthorizationSession | ContextSession): SessionStore {
  let view: StoreView = { snapshot: snapshotOf(session), stretch: 0 };
  const listeners = new Set<() => void>();

  const onState = (): void => {
    const next = snapshotOf(session);
    if (sameSnapshot(view.snapshot, next)) {
      return;
    }
    view = {
      snapshot: next,
      stretch: next.status === "READY" ? view.stretch : view.stretch + 1,
    };
    for (const listener of [...listeners]) {
      listener();
    }
  };

  // The state is read back through the session rather than taken from the argument, so the list of
  // contexts is read at the same moment as the state it goes with.
  session.subscribe(onState);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getView: () => view,
  };
}
