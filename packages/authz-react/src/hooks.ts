import type { ContextSession } from "@ricardoqmd/authz-context";
import {
  decisionFor,
  isRenderable,
  permissionFor,
  type AuthorizationSession,
  type Decision,
  type DecisionEffect,
  type DecisionRequest,
} from "@ricardoqmd/authz-core";
import {
  createElement,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import { useBinding, type Binding } from "./provider.js";
import type { AuthzSnapshot, SessionStore, StoreView } from "./store.js";

function useView(binding: Binding): StoreView {
  const { store } = binding;
  return useSyncExternalStore(store.subscribe, store.getView, store.getView);
}

/** The provider's state, and the two things a screen does to it. */
export function useAuthz(): AuthzSnapshot & {
  readonly selectContext: (contextId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
} {
  const binding = useBinding("useAuthz");
  const { snapshot } = useView(binding);
  const { selectContext, refresh } = binding;
  return useMemo(() => ({ ...snapshot, selectContext, refresh }), [snapshot, selectContext, refresh]);
}

/**
 * The session itself: for what this package does not do. A `ContextSession` when the provider was
 * given a `contextTransport`, an `AuthorizationSession` otherwise, and a different object after every
 * `refresh()`.
 */
export function useAuthzSession(): AuthorizationSession | ContextSession {
  return useBinding("useAuthzSession").session;
}

/** The menu's effect for one action: `DENY` unless the provider is `READY` and the menu says otherwise. */
export function usePermissionEffect(action: string): DecisionEffect {
  const { snapshot } = useView(useBinding("usePermissionEffect"));
  // The snapshot holds a menu only while `READY`, so every other status reads as absent.
  return permissionFor(snapshot.permissions, action);
}

/** Whether an action is rendered: `PERMIT` and `CONDITIONAL` are, `DENY` is not. */
export function usePermission(action: string): boolean {
  return isRenderable(usePermissionEffect(action));
}

export interface DecisionLookup {
  readonly can: (action: string, resourceId: string) => boolean;
  readonly effectOf: (action: string, resourceId: string) => DecisionEffect;
  readonly isLoading: boolean;
}

interface Answer {
  readonly store: SessionStore;
  readonly stretch: number;
  readonly key: string;
  readonly decisions: readonly Decision[];
}

const NO_DECISIONS: readonly Decision[] = Object.freeze([]);

const denied = (): DecisionEffect => "DENY";
const hidden = (): boolean => false;

/** A request's identity is what it asks, so an equal request written inline is the same request. */
function keyOf(request: DecisionRequest): string {
  return JSON.stringify([request.resourceType, request.actions, request.resourceIds]);
}

/**
 * Instance-level decisions for one request, asked of the provider's session.
 *
 * **A lookup answers from the answer to the request it was last given, asked of the session in use since
 * the provider last became `READY`, and `DENY` for everything else.** Nothing is asked while the provider
 * is not `READY`. An answer to an earlier request, or one asked before the provider last left `READY`, is
 * not used. A request the session refuses answers `DENY`. `isLoading` is `true` while a request is given,
 * the provider is `READY`, and the session has neither answered nor refused it.
 */
export function useDecisions(request: DecisionRequest | null): DecisionLookup {
  const binding = useBinding("useDecisions");
  const { snapshot, stretch } = useView(binding);
  const { session, store } = binding;

  const key = request === null ? null : keyOf(request);
  const ready = snapshot.status === "READY";

  const [answer, setAnswer] = useState<Answer | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const latestCall = useRef<object | null>(null);

  useEffect(() => {
    const asked = requestRef.current;
    if (key === null || !ready || asked === null) {
      return undefined;
    }
    const call = {};
    latestCall.current = call;
    const accept = (decisions: readonly Decision[]): void => {
      if (latestCall.current === call) {
        setAnswer({ store, stretch, key, decisions });
      }
    };
    session.decide(asked).then(accept, () => accept(NO_DECISIONS));
    return () => {
      if (latestCall.current === call) {
        latestCall.current = null;
      }
    };
  }, [session, store, stretch, key, ready]);

  const held =
    key !== null &&
    ready &&
    answer !== null &&
    answer.store === store &&
    answer.stretch === stretch &&
    answer.key === key
      ? answer.decisions
      : undefined;
  const isLoading = key !== null && ready && held === undefined;

  return useMemo<DecisionLookup>(() => {
    if (held === undefined) {
      return { can: hidden, effectOf: denied, isLoading };
    }
    return {
      can: (action, resourceId) => isRenderable(decisionFor(held, action, resourceId)),
      effectOf: (action, resourceId) => decisionFor(held, action, resourceId),
      isLoading,
    };
  }, [held, isLoading]);
}

/** Renders `children` when the action is rendered, and `fallback` otherwise. */
export function PermissionGuard(props: {
  action: string;
  children: ReactNode;
  fallback?: ReactNode;
}): ReactElement {
  const renderable = usePermission(props.action);
  return createElement(Fragment, null, renderable ? props.children : props.fallback);
}
