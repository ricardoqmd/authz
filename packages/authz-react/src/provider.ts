import {
  createContextSession,
  type ContextSession,
  type ContextTransport,
} from "@ricardoqmd/authz-context";
import {
  createAuthorizationSession,
  type AuthorizationDiagnostic,
  type AuthorizationSession,
  type AuthorizationTransport,
} from "@ricardoqmd/authz-core";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
} from "react";

import { createSessionStore, type SessionStore } from "./store.js";

export interface AuthzProviderProps {
  readonly app: string;
  /** One transport, or one per context when the application has contexts. */
  readonly transport: AuthorizationTransport | ((contextId?: string) => AuthorizationTransport);
  /** Present only when the application has contexts. */
  readonly contextTransport?: ContextTransport;
  readonly maxPairsPerRequest?: number;
  readonly maxCachedDecisions?: number;
  /** Passed to every session this provider builds. */
  readonly onDiagnostic?: (event: AuthorizationDiagnostic) => void;
  /** Registers an invalidation signal; returns the unsubscribe. */
  readonly onInvalidated?: (refresh: () => Promise<void>) => () => void;
  readonly children: ReactNode;
}

/** What the hooks below the provider share. */
export interface Binding {
  readonly session: AuthorizationSession | ContextSession;
  readonly store: SessionStore;
  readonly selectContext: (contextId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

const BindingContext = createContext<Binding | null>(null);

/**
 * The binding of the nearest provider.
 *
 * **Throws without one.** A permission read with no provider above it has no session to answer from,
 * and any value it returned would be read as an answer: `false` as a real denial, `true` as a grant.
 */
export function useBinding(hook: string): Binding {
  const binding = useContext(BindingContext);
  if (binding === null) {
    throw new Error(`${hook}() must be called inside <AuthzProvider>`);
  }
  return binding;
}

/** The props a change to builds a new session, and the count of `refresh()` calls. */
interface BuildKey {
  readonly app: string;
  readonly maxPairsPerRequest: number | undefined;
  readonly maxCachedDecisions: number | undefined;
  readonly withContexts: boolean;
  readonly generation: number;
}

interface Built {
  readonly key: BuildKey;
  readonly session: AuthorizationSession | ContextSession;
  readonly store: SessionStore;
}

function sameKey(a: BuildKey, b: BuildKey): boolean {
  return (
    Object.is(a.app, b.app) &&
    Object.is(a.maxPairsPerRequest, b.maxPairsPerRequest) &&
    Object.is(a.maxCachedDecisions, b.maxCachedDecisions) &&
    a.withContexts === b.withContexts &&
    a.generation === b.generation
  );
}

function build(props: MutableRefObject<AuthzProviderProps>, key: BuildKey): Built {
  // Read when a permissions session is built, which for an application with contexts is when a
  // context is entered, so the props of that moment are the ones used.
  const permissionsSession = (contextId?: string): AuthorizationSession => {
    const { transport, onDiagnostic } = props.current;
    return createAuthorizationSession({
      app: key.app,
      transport: typeof transport === "function" ? transport(contextId) : transport,
      // Passed as given. The core has no default for it and refuses a missing one when a decision
      // is asked, which is where that refusal belongs.
      maxPairsPerRequest: key.maxPairsPerRequest as number,
      maxCachedDecisions: key.maxCachedDecisions,
      onDiagnostic,
    });
  };

  const { contextTransport } = props.current;
  const session =
    key.withContexts && contextTransport !== undefined
      ? createContextSession({
          app: key.app,
          contextTransport,
          buildSession: (contextId) => permissionsSession(contextId),
        })
      : permissionsSession();
  return { key, session, store: createSessionStore(session) };
}

/** Sessions this provider has closed. A closed session is inert and cannot be started again. */
const closedSessions = new WeakSet<object>();

/**
 * Builds a session from its props, starts it, and closes it when it is replaced or unmounted.
 *
 * **Of the props, `app`, `maxPairsPerRequest`, `maxCachedDecisions` and whether `contextTransport` is
 * given are the ones a change to builds a new session.** Every other prop is read when a session is
 * built, and a new value in it builds none. A transport or a callback written inline is a new value on
 * every render; were it to build a session, that session would start, and ask its transport again, on
 * every render.
 */
export function AuthzProvider(props: AuthzProviderProps): ReactElement {
  const latestProps = useRef(props);
  latestProps.current = props;

  const [generation, setGeneration] = useState(0);
  const key: BuildKey = {
    app: props.app,
    maxPairsPerRequest: props.maxPairsPerRequest,
    maxCachedDecisions: props.maxCachedDecisions,
    withContexts: props.contextTransport !== undefined,
    generation,
  };

  const [built, setBuilt] = useState<Built>(() => build(latestProps, key));
  let current = built;
  if (!sameKey(built.key, key)) {
    current = build(latestProps, key);
    setBuilt(current);
  }
  const currentRef = useRef(current);
  currentRef.current = current;

  const generationRef = useRef(0);
  const pendingRefreshes = useRef<{ generation: number; resolve: () => void }[]>([]);
  const mounted = useRef(true);

  const settleRefreshes = useCallback((upTo: number) => {
    const due = pendingRefreshes.current.filter((pending) => pending.generation <= upTo);
    pendingRefreshes.current = pendingRefreshes.current.filter((pending) => pending.generation > upTo);
    for (const pending of due) {
      pending.resolve();
    }
  }, []);

  useEffect(() => {
    const { session } = built;
    if (closedSessions.has(session)) {
      // React ran this effect again after its cleanup closed the session, as it does in development
      // under `StrictMode`. The closed session cannot answer, so another one takes its place.
      setBuilt(build(latestProps, built.key));
      return undefined;
    }
    let live = true;
    const started = (): void => {
      if (live) {
        settleRefreshes(built.key.generation);
      }
    };
    session.start().then(started, started);
    return () => {
      live = false;
      closedSessions.add(session);
      session.close();
    };
  }, [built, settleRefreshes]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      settleRefreshes(Number.POSITIVE_INFINITY);
    };
  }, [settleRefreshes]);

  const refresh = useCallback(
    () =>
      new Promise<void>((resolve) => {
        if (!mounted.current) {
          resolve();
          return;
        }
        generationRef.current += 1;
        pendingRefreshes.current.push({ generation: generationRef.current, resolve });
        setGeneration(generationRef.current);
      }),
    [],
  );

  const selectContext = useCallback(async (contextId: string) => {
    const { session } = currentRef.current;
    if (!("selectContext" in session)) {
      throw new RangeError("selectContext(): this provider was given no contextTransport");
    }
    if (pendingRefreshes.current.length > 0) {
      throw new RangeError(
        "selectContext(): a refresh() is under way, and the session it would act on is being replaced",
      );
    }
    if (closedSessions.has(session)) {
      throw new RangeError("selectContext(): the session it would act on is closed, and is being replaced");
    }
    await session.selectContext(contextId);
    if (currentRef.current.session !== session) {
      throw new RangeError("selectContext(): the session it acted on was replaced before the context was entered");
    }
  }, []);

  const hasInvalidationSignal = props.onInvalidated !== undefined;
  useEffect(() => {
    const register = latestProps.current.onInvalidated;
    if (register === undefined) {
      return undefined;
    }
    return register(refresh);
  }, [hasInvalidationSignal, refresh]);

  const binding = useMemo<Binding>(
    () => ({ session: current.session, store: current.store, selectContext, refresh }),
    [current, selectContext, refresh],
  );

  return createElement(BindingContext.Provider, { value: binding }, props.children);
}
