import {
  createContextSession,
  type AuthorizationContext,
  type ContextSession,
  type ContextTransport,
} from "@ricardoqmd/authz-context";
import {
  AuthorizationTransportError,
  createAuthorizationSession,
  type AuthorizationDiagnostic,
  type AuthorizationSession,
  type AuthorizationTransport,
  type DecisionEffect,
  type DecisionRequest,
  type DecisionSet,
  type PermissionMenu,
} from "@ricardoqmd/authz-core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  AuthzProvider,
  PermissionGuard,
  useAuthz,
  useAuthzSession,
  useDecisions,
  usePermission,
  usePermissionEffect,
} from "./index.js";
import { createSessionStore, type StoreView } from "./store.js";

/**
 * Every session the provider builds, as built: the real ones, with `start`, `close`, `decide` and
 * `lastListedContexts` observed and left to do what they do.
 */
type Observed<T> = T & {
  start: MockInstance<() => Promise<void>>;
  close: MockInstance<() => void>;
};

const built = vi.hoisted(() => ({
  permissions: [] as Observed<AuthorizationSession>[],
  contexts: [] as Observed<ContextSession>[],
}));

vi.mock("@ricardoqmd/authz-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ricardoqmd/authz-core")>();
  return {
    ...actual,
    createAuthorizationSession: (
      options: Parameters<typeof actual.createAuthorizationSession>[0],
    ) => {
      const session = actual.createAuthorizationSession(options);
      vi.spyOn(session, "start");
      vi.spyOn(session, "close");
      vi.spyOn(session, "decide");
      built.permissions.push(session as Observed<AuthorizationSession>);
      return session;
    },
  };
});

vi.mock("@ricardoqmd/authz-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ricardoqmd/authz-context")>();
  return {
    ...actual,
    createContextSession: (options: Parameters<typeof actual.createContextSession>[0]) => {
      const session = actual.createContextSession(options);
      vi.spyOn(session, "start");
      vi.spyOn(session, "close");
      vi.spyOn(session, "lastListedContexts");
      built.contexts.push(session as Observed<ContextSession>);
      return session;
    },
  };
});

afterEach(() => {
  cleanup();
  built.permissions.length = 0;
  built.contexts.length = 0;
  vi.restoreAllMocks();
});

const APP = "app-a";
const READ_R1: DecisionRequest = { resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function menuOf(...entries: [string, DecisionEffect][]): PermissionMenu {
  return { app: APP, permissions: entries.map(([action, effect]) => ({ action, effect })) };
}

function answerAll(request: DecisionRequest, effect: DecisionEffect): DecisionSet {
  return {
    app: APP,
    decisions: request.actions.flatMap((action) =>
      request.resourceIds.map((resourceId) => ({ action, resourceId, effect })),
    ),
  };
}

/** A transport that answers at once: this menu, and `effect` for every pair it is asked. */
function answering(menu: PermissionMenu, effect: DecisionEffect = "PERMIT") {
  return {
    fetchPermissions: vi.fn(async () => menu),
    fetchDecisions: vi.fn(async (_app: string, request: DecisionRequest) => answerAll(request, effect)),
  };
}

/** A transport that holds every answer until the test settles it. */
function parked() {
  const menus: Deferred<PermissionMenu>[] = [];
  const decisions: { request: DecisionRequest; answer: Deferred<DecisionSet> }[] = [];
  const transport = {
    fetchPermissions: vi.fn(() => {
      const menu = deferred<PermissionMenu>();
      menus.push(menu);
      return menu.promise;
    }),
    fetchDecisions: vi.fn((_app: string, request: DecisionRequest) => {
      const answer = deferred<DecisionSet>();
      decisions.push({ request, answer });
      return answer.promise;
    }),
  };
  return { transport, menus, decisions };
}

function context(contextId: string, hasAccess = true): AuthorizationContext {
  return { contextId, label: contextId, hasAccess };
}

function listing(...contexts: AuthorizationContext[]): ContextTransport {
  return { listContexts: async () => contexts };
}

/** Lets every pending promise and effect run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function Status() {
  const { status, contextId, contexts, permissions } = useAuthz();
  const listed = contexts.map((c) => c.contextId).join(",");
  return (
    <output data-testid="status">{`${status}|${contextId ?? "-"}|${listed}|${permissions.length}`}</output>
  );
}

function Lookup({ request }: { request: DecisionRequest | null }) {
  const lookup = useDecisions(request);
  const pairs = ["r-1", "r-2"].map((id) => `${id}=${lookup.effectOf("read", id)}/${lookup.can("read", id)}`);
  return <output data-testid="lookup">{`${pairs.join(" ")}|loading=${lookup.isLoading}`}</output>;
}

function Menu({ action }: { action: string }) {
  const effect = usePermissionEffect(action);
  const shown = usePermission(action);
  return <output data-testid={`menu-${action}`}>{`${effect}/${shown}`}</output>;
}

function Guarded({ action }: { action: string }) {
  return (
    <PermissionGuard action={action} fallback={<span>{`${action} hidden`}</span>}>
      <span>{`${action} shown`}</span>
    </PermissionGuard>
  );
}

type Api = ReturnType<typeof useAuthz>;

/** Hands the test what the hooks returned on the last render. */
function Capture({ api, session }: { api?: { current?: Api }; session?: { current?: unknown } }) {
  const current = useAuthz();
  const held = useAuthzSession();
  if (api !== undefined) api.current = current;
  if (session !== undefined) session.current = held;
  return null;
}

const text = (id: string) => screen.getByTestId(id).textContent;

function Provider(props: {
  transport: AuthorizationTransport | ((contextId?: string) => AuthorizationTransport);
  contextTransport?: ContextTransport;
  onDiagnostic?: (event: AuthorizationDiagnostic) => void;
  onInvalidated?: (refresh: () => Promise<void>) => () => void;
  maxPairsPerRequest?: number | null;
  app?: string;
  children: ReactNode;
}) {
  return (
    <AuthzProvider
      app={props.app ?? APP}
      transport={props.transport}
      contextTransport={props.contextTransport}
      maxPairsPerRequest={props.maxPairsPerRequest === null ? undefined : (props.maxPairsPerRequest ?? 10)}
      onDiagnostic={props.onDiagnostic}
      onInvalidated={props.onInvalidated}
    >
      {props.children}
    </AuthzProvider>
  );
}

describe("the snapshot is the same object while the session's state has not changed", () => {
  it("a screen over a session that settles renders once it settles, and not again forever", async () => {
    render(
      <Provider transport={answering(menuOf(["read", "PERMIT"]))}>
        <Status />
        <Menu action="read" />
      </Provider>,
    );
    await settle();
    expect(text("status")).toBe("READY|-||1");
    expect(text("menu-read")).toBe("PERMIT/true");
  });

  it("the store hands out one view per state, through the repeated emissions of a context session", async () => {
    const session = createContextSession({
      app: APP,
      contextTransport: listing(context("a")),
      buildSession: () =>
        createAuthorizationSession({
          app: APP,
          maxPairsPerRequest: 10,
          transport: answering(menuOf(["read", "PERMIT"])),
        }),
    });
    const store = createSessionStore(session);
    const views: StoreView[] = [];
    store.subscribe(() => views.push(store.getView()));
    let emissions = 0;
    session.subscribe(() => {
      emissions += 1;
    });

    expect(store.getView()).toBe(store.getView());
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getView()).toBe(store.getView());
    expect(store.getView().snapshot.status).toBe("READY");
    expect(new Set(views).size).toBe(views.length);
    // The context session published more states than the store published views: the repeats were
    // equal, and an equal state keeps the view it had.
    expect(emissions).toBeGreaterThan(views.length);
  });
});

describe("the snapshot of every state of both kinds of session", () => {
  /** A session that publishes whatever state the test hands it. */
  function publishing<S>(initial: S, extra: object) {
    let state = initial;
    const listeners = new Set<(s: S) => void>();
    return {
      session: {
        getState: () => state,
        subscribe: (listener: (s: S) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ...extra,
      },
      publish(next: S) {
        state = next;
        for (const listener of listeners) listener(next);
      },
    };
  }

  const entry = { action: "read", effect: "PERMIT" as const };
  const describeView = (view: StoreView) =>
    `${view.snapshot.status}|${view.snapshot.contextId ?? "-"}|${view.snapshot.contexts.length}|${view.snapshot.permissions.length}`;

  it("a session without contexts: four statuses, a menu only while READY, never a context", () => {
    const fake = publishing<{ status: string; permissions?: unknown[] }>({ status: "IDLE" }, {
      start: async () => undefined,
      decide: async () => [],
      close: () => undefined,
    });
    const store = createSessionStore(fake.session as unknown as AuthorizationSession);
    const seen = [describeView(store.getView())];
    for (const next of [
      { status: "LOADING" },
      { status: "READY", permissions: [entry] },
      { status: "NO_ACCESS_IN_APP" },
      { status: "UNAVAILABLE" },
    ]) {
      fake.publish(next);
      seen.push(describeView(store.getView()));
    }
    expect(seen).toEqual(["LOADING|-|0|0", "LOADING|-|0|0", "READY|-|0|1", "NO_ACCESS_IN_APP|-|0|0", "UNAVAILABLE|-|0|0"]);
  });

  it("a context session: every status, the context it is in, and the list lastListedContexts() returns", () => {
    let listed: AuthorizationContext[] | undefined;
    const fake = publishing<Record<string, unknown>>({ status: "IDLE" }, {
      start: async () => undefined,
      decide: async () => [],
      close: () => undefined,
      selectContext: async () => undefined,
      lastListedContexts: () => (listed === undefined ? undefined : [...listed]),
    });
    const store = createSessionStore(fake.session as unknown as ContextSession);
    const seen = [describeView(store.getView())];
    const steps: [AuthorizationContext[] | undefined, Record<string, unknown>][] = [
      [undefined, { status: "LOADING_CONTEXTS" }],
      [[], { status: "NO_CONTEXTS" }],
      [[context("a"), context("b")], { status: "CHOOSING_CONTEXT", contexts: [] }],
      [[context("a"), context("b")], { status: "IN_CONTEXT", contextId: "a", permissions: { status: "IDLE" } }],
      [[context("a"), context("b")], { status: "IN_CONTEXT", contextId: "a", permissions: { status: "LOADING" } }],
      [[context("a"), context("b")], { status: "IN_CONTEXT", contextId: "a", permissions: { status: "READY", permissions: [entry] } }],
      [[context("a"), context("b")], { status: "IN_CONTEXT", contextId: "a", permissions: { status: "NO_ACCESS_IN_APP" } }],
      [[context("a"), context("b")], { status: "IN_CONTEXT", contextId: "a", permissions: { status: "UNAVAILABLE" } }],
      [[context("a"), context("b")], { status: "NO_ACCESS_IN_APP", contextId: "b", contexts: [] }],
      [undefined, { status: "UNAVAILABLE" }],
    ];
    for (const [list, next] of steps) {
      listed = list;
      fake.publish(next);
      seen.push(describeView(store.getView()));
    }
    expect(seen).toEqual([
      "LOADING|-|0|0",
      "LOADING|-|0|0",
      "NO_CONTEXTS|-|0|0",
      "CHOOSING_CONTEXT|-|2|0",
      "LOADING|a|2|0",
      "LOADING|a|2|0",
      "READY|a|2|1",
      "NO_ACCESS_IN_APP|a|2|0",
      "UNAVAILABLE|a|2|0",
      "NO_ACCESS_IN_APP|b|2|0",
      "UNAVAILABLE|-|0|0",
    ]);
  });
});

describe("props written inline do not build a new session", () => {
  it("a transport factory, a diagnostic callback and an invalidation signal: one session, one start", async () => {
    const factoryCalls: (string | undefined)[] = [];
    let menuCalls = 0;
    let registrations = 0;

    function Screen() {
      const [renders, setRenders] = useState(0);
      return (
        <AuthzProvider
          app={APP}
          maxPairsPerRequest={10}
          transport={(contextId) => {
            factoryCalls.push(contextId);
            return {
              fetchPermissions: async () => {
                menuCalls += 1;
                return menuOf(["read", "PERMIT"]);
              },
              fetchDecisions: async (_app, request) => answerAll(request, "PERMIT"),
            };
          }}
          onDiagnostic={(event) => {
            void event;
          }}
          onInvalidated={() => {
            registrations += 1;
            return () => undefined;
          }}
        >
          <button type="button" onClick={() => setRenders((n) => n + 1)}>{`render ${renders}`}</button>
          <Status />
        </AuthzProvider>
      );
    }

    render(<Screen />);
    await settle();
    for (let i = 0; i < 5; i += 1) {
      await act(async () => screen.getByRole("button").click());
    }
    await settle();

    expect(screen.getByRole("button").textContent).toBe("render 5");
    expect(text("status")).toBe("READY|-||1");
    expect(built.permissions).toHaveLength(1);
    expect(built.permissions[0]?.start).toHaveBeenCalledTimes(1);
    expect(factoryCalls).toEqual([undefined]);
    expect(menuCalls).toBe(1);
    expect(registrations).toBe(1);
  });

  it("a transport object and a context transport: one context session, one start", async () => {
    let listings = 0;

    function Screen() {
      const [renders, setRenders] = useState(0);
      return (
        <AuthzProvider
          app={APP}
          maxPairsPerRequest={10}
          transport={{
            fetchPermissions: async () => menuOf(["read", "PERMIT"]),
            fetchDecisions: async (_app, request) => answerAll(request, "PERMIT"),
          }}
          contextTransport={{
            listContexts: async () => {
              listings += 1;
              return [context("a")];
            },
          }}
        >
          <button type="button" onClick={() => setRenders((n) => n + 1)}>{`render ${renders}`}</button>
          <Status />
        </AuthzProvider>
      );
    }

    render(<Screen />);
    await settle();
    for (let i = 0; i < 5; i += 1) {
      await act(async () => screen.getByRole("button").click());
    }
    await settle();

    expect(screen.getByRole("button").textContent).toBe("render 5");
    expect(text("status")).toBe("READY|a|a|1");
    expect(built.contexts).toHaveLength(1);
    expect(built.contexts[0]?.start).toHaveBeenCalledTimes(1);
    expect(built.permissions).toHaveLength(1);
    expect(listings).toBe(1);
  });
});

describe("refresh() builds a new session and drops the decisions held", () => {
  it("a lookup that answered before answers DENY until the new session's answer arrives", async () => {
    const later = deferred<DecisionSet>();
    let decisionCalls = 0;
    const transport: AuthorizationTransport = {
      fetchPermissions: async () => menuOf(["read", "PERMIT"]),
      fetchDecisions: async (_app, request) => {
        decisionCalls += 1;
        return decisionCalls === 1 ? answerAll(request, "PERMIT") : later.promise;
      },
    };
    const api: { current?: Api } = {};

    render(
      <Provider transport={transport}>
        <Capture api={api} />
        <Lookup request={READ_R1} />
      </Provider>,
    );
    await settle();
    expect(text("lookup")).toBe("r-1=PERMIT/true r-2=DENY/false|loading=false");

    await act(async () => {
      void api.current?.refresh();
    });
    await settle();

    expect(built.permissions).toHaveLength(2);
    expect(built.permissions[0]?.close).toHaveBeenCalledTimes(1);
    expect(decisionCalls).toBe(2);
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=true");

    await act(async () => later.resolve(answerAll(READ_R1, "PERMIT")));
    await settle();
    expect(text("lookup")).toBe("r-1=PERMIT/true r-2=DENY/false|loading=false");
  });

  it("its promise settles once the new session has settled", async () => {
    const { transport, menus } = parked();
    const api: { current?: Api } = {};
    render(
      <Provider transport={transport}>
        <Capture api={api} />
        <Status />
      </Provider>,
    );
    await settle();
    await act(async () => menus[0]?.resolve(menuOf(["read", "PERMIT"])));
    await settle();

    let refreshed = false;
    await act(async () => {
      void api.current?.refresh().then(() => {
        refreshed = true;
      });
    });
    await settle();
    expect(text("status")).toBe("LOADING|-||0");
    expect(refreshed).toBe(false);

    await act(async () => menus[1]?.resolve(menuOf(["read", "PERMIT"])));
    await settle();
    expect(text("status")).toBe("READY|-||1");
    expect(refreshed).toBe(true);
  });

  it("an invalidation signal refreshes, and is unsubscribed on unmount", async () => {
    let signal: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const view = render(
      <Provider
        transport={answering(menuOf(["read", "PERMIT"]))}
        onInvalidated={(refresh) => {
          signal = refresh;
          return unsubscribe;
        }}
      >
        <Status />
      </Provider>,
    );
    await settle();
    await act(async () => {
      void signal?.();
    });
    await settle();

    expect(built.permissions).toHaveLength(2);
    expect(built.permissions[0]?.close).toHaveBeenCalledTimes(1);
    expect(text("status")).toBe("READY|-||1");

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("with contexts, the new session lists them again, so a choice among several is asked again", async () => {
    const setup = twoContexts();
    const api: { current?: Api } = {};
    render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} />
        <Status />
      </Provider>,
    );
    await settle();
    await act(async () => api.current?.selectContext("a"));
    await settle();
    expect(text("status")).toBe("READY|a|a,b|1");

    await act(async () => {
      void api.current?.refresh();
    });
    await settle();
    expect(built.contexts).toHaveLength(2);
    expect(built.contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(text("status")).toBe("CHOOSING_CONTEXT|-|a,b|0");
  });

  it("selectContext() while a refresh() is under way rejects with a RangeError, and enters no context", async () => {
    const setup = twoContexts();
    const api: { current?: Api } = {};
    render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} />
        <Status />
      </Provider>,
    );
    await settle();
    await act(async () => api.current?.selectContext("a"));
    await settle();
    expect(text("status")).toBe("READY|a|a,b|1");
    const replaced = built.contexts[0];
    const permissionsBuilt = built.permissions.length;

    let outcome: unknown = "pending";
    let stateAfterCall: unknown;
    let permissionsAfterCall = 0;
    await act(async () => {
      const held = api.current!;
      void held.refresh();
      outcome = await held.selectContext("b").then(
        () => "resolved",
        (error: unknown) => error,
      );
      stateAfterCall = replaced?.getState();
      permissionsAfterCall = built.permissions.length;
    });
    expect(outcome).toBeInstanceOf(RangeError);
    expect(stateAfterCall).toMatchObject({ status: "IN_CONTEXT", contextId: "a" });
    expect(permissionsAfterCall).toBe(permissionsBuilt);

    await settle();
    expect(text("status")).toBe("CHOOSING_CONTEXT|-|a,b|0");
  });

  it("the function an invalidation signal is given settles once the new session has, so the previous context can be entered after it", async () => {
    const setup = twoContexts();
    const api: { current?: Api } = {};
    let signal: (() => Promise<void>) | undefined;
    render(
      <Provider
        transport={setup.transport}
        contextTransport={setup.contextTransport}
        onInvalidated={(refresh) => {
          signal = refresh;
          return () => undefined;
        }}
      >
        <Capture api={api} />
        <Status />
      </Provider>,
    );
    await settle();
    await act(async () => api.current?.selectContext("b"));
    await settle();
    expect(text("status")).toBe("READY|b|a,b|1");
    const previous = api.current!.contextId!;
    const held = api.current!;

    let settledOn: unknown = "pending";
    let restored: Promise<unknown> = Promise.resolve("pending");
    await act(async () => {
      restored = Promise.resolve(signal?.()).then(async () => {
        const latest = built.contexts[built.contexts.length - 1];
        settledOn = latest === built.contexts[0] ? "the session being replaced" : latest?.getState().status;
        await held.selectContext(previous);
        return "entered";
      });
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await restored.catch((error: unknown) => error);
    });
    await settle();

    expect(settledOn).toBe("CHOOSING_CONTEXT");
    expect(outcome).toBe("entered");
    expect(built.contexts).toHaveLength(2);
    expect(text("status")).toBe("READY|b|a,b|1");
  });

  it("useAuthzSession() returns the session in use, before and after a refresh", async () => {
    const api: { current?: Api } = {};
    const session: { current?: unknown } = {};
    render(
      <Provider transport={answering(menuOf(["read", "PERMIT"]))}>
        <Capture api={api} session={session} />
      </Provider>,
    );
    await settle();
    expect(session.current).toBe(built.permissions[0]);

    await act(async () => {
      void api.current?.refresh();
    });
    await settle();
    expect(session.current).toBe(built.permissions[1]);
  });
});

/** Contexts `a` and `b`; the transport of `b` holds its answers until the test settles them. */
function twoContexts(options: { parkMenuOfB?: boolean; parkDecisionsOf?: "a" | "b" } = {}) {
  const heldDecisions: { request: DecisionRequest; answer: Deferred<DecisionSet> }[] = [];
  const heldMenus: Deferred<PermissionMenu>[] = [];
  const factoryCalls: (string | undefined)[] = [];
  const transport = (contextId?: string): AuthorizationTransport => {
    factoryCalls.push(contextId);
    return {
      fetchPermissions: async () => {
        if (contextId === "b" && options.parkMenuOfB === true) {
          const menu = deferred<PermissionMenu>();
          heldMenus.push(menu);
          return menu.promise;
        }
        return menuOf(["read", "PERMIT"]);
      },
      fetchDecisions: async (_app, request) => {
        if (contextId === options.parkDecisionsOf) {
          const answer = deferred<DecisionSet>();
          heldDecisions.push({ request, answer });
          return answer.promise;
        }
        return answerAll(request, contextId === "a" ? "PERMIT" : "DENY");
      },
    };
  };
  return { transport, heldDecisions, heldMenus, factoryCalls, contextTransport: listing(context("a"), context("b")) };
}

describe("selectContext() drops everything derived from the previous context", () => {
  it("decide under one context, switch, look up: DENY until the new context answers", async () => {
    const setup = twoContexts({ parkDecisionsOf: "b" });
    const api: { current?: Api } = {};
    render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} />
        <Status />
        <Lookup request={READ_R1} />
      </Provider>,
    );
    await settle();
    expect(text("status")).toBe("CHOOSING_CONTEXT|-|a,b|0");

    await act(async () => api.current?.selectContext("a"));
    await settle();
    expect(text("status")).toBe("READY|a|a,b|1");
    expect(text("lookup")).toBe("r-1=PERMIT/true r-2=DENY/false|loading=false");

    await act(async () => api.current?.selectContext("b"));
    await settle();
    expect(text("status")).toBe("READY|b|a,b|1");
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=true");

    await act(async () => setup.heldDecisions[0]?.answer.resolve(answerAll(READ_R1, "CONDITIONAL")));
    await settle();
    expect(text("lookup")).toBe("r-1=CONDITIONAL/true r-2=DENY/false|loading=false");
  });

  it("an answer asked under the previous context that arrives after the switch is not used", async () => {
    const setup = twoContexts({ parkDecisionsOf: "a" });
    const api: { current?: Api } = {};
    render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} />
        <Lookup request={READ_R1} />
      </Provider>,
    );
    await settle();
    await act(async () => api.current?.selectContext("a"));
    await settle();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=true");

    await act(async () => api.current?.selectContext("b"));
    await settle();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=false");

    await act(async () => setup.heldDecisions[0]?.answer.resolve(answerAll(READ_R1, "PERMIT")));
    await settle();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=false");
  });
});

function Everything() {
  return (
    <>
      <Status />
      <Menu action="read" />
      <Guarded action="read" />
      <Lookup request={READ_R1} />
    </>
  );
}

describe("before READY, every lookup and every permission answers closed", () => {
  const cases: [string, () => AuthorizationTransport["fetchPermissions"], string][] = [
    ["LOADING", () => () => new Promise<PermissionMenu>(() => undefined), "LOADING|-||0"],
    ["UNAVAILABLE", () => async () => Promise.reject(new Error("unreachable")), "UNAVAILABLE|-||0"],
    [
      "NO_ACCESS_IN_APP",
      () => async () => Promise.reject(new AuthorizationTransportError("NO_ACCESS_IN_APP")),
      "NO_ACCESS_IN_APP|-||0",
    ],
  ];

  it.each(cases)("%s: false, DENY, the fallback, and no decision asked", async (_status, menu, shown) => {
    const decisions = vi.fn(async (_app: string, request: DecisionRequest) => answerAll(request, "PERMIT"));
    render(
      <Provider transport={{ fetchPermissions: menu(), fetchDecisions: decisions }}>
        <Everything />
      </Provider>,
    );
    await settle();

    expect(text("status")).toBe(shown);
    expect(text("menu-read")).toBe("DENY/false");
    expect(screen.getByText("read hidden")).toBeDefined();
    expect(screen.queryByText("read shown")).toBeNull();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=false");
    expect(decisions).not.toHaveBeenCalled();
  });

  it("a context whose menu has not arrived answers closed, not with the previous context's menu", async () => {
    const setup = twoContexts({ parkMenuOfB: true });
    const api: { current?: Api } = {};
    render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} />
        <Everything />
      </Provider>,
    );
    await settle();
    await act(async () => api.current?.selectContext("a"));
    await settle();
    expect(text("menu-read")).toBe("PERMIT/true");
    expect(screen.getByText("read shown")).toBeDefined();

    await act(async () => {
      void api.current?.selectContext("b");
    });
    await settle();
    expect(text("status")).toBe("LOADING|b|a,b|0");
    expect(text("menu-read")).toBe("DENY/false");
    expect(screen.getByText("read hidden")).toBeDefined();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=false");

    await act(async () =>
      setup.heldMenus[0]?.reject(new AuthorizationTransportError("NO_ACCESS_IN_APP")),
    );
    await settle();
    expect(text("status")).toBe("NO_ACCESS_IN_APP|b|a,b|0");
    expect(text("menu-read")).toBe("DENY/false");
  });

  it("a context that does not open the application answers closed", async () => {
    const transport = answering(menuOf(["read", "PERMIT"]));
    render(
      <Provider transport={transport} contextTransport={listing(context("c", false))}>
        <Everything />
      </Provider>,
    );
    await settle();
    expect(text("status")).toBe("NO_ACCESS_IN_APP|c|c|0");
    expect(text("menu-read")).toBe("DENY/false");
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=false");
    expect(transport.fetchDecisions).not.toHaveBeenCalled();
  });

  it("READY renders PERMIT and CONDITIONAL, and not DENY or an action the menu does not name", async () => {
    render(
      <Provider transport={answering(menuOf(["read", "PERMIT"], ["edit", "CONDITIONAL"], ["drop", "DENY"]))}>
        <Guarded action="read" />
        <Guarded action="edit" />
        <Guarded action="drop" />
        <Guarded action="share" />
        <Menu action="edit" />
      </Provider>,
    );
    await settle();
    expect(screen.getByText("read shown")).toBeDefined();
    expect(screen.getByText("edit shown")).toBeDefined();
    expect(screen.getByText("drop hidden")).toBeDefined();
    expect(screen.getByText("share hidden")).toBeDefined();
    expect(text("menu-edit")).toBe("CONDITIONAL/true");
  });
});

describe("an answer that arrives after a later request is discarded", () => {
  it("two requests answered out of order: the later request's answer is the one used", async () => {
    const { transport, menus, decisions } = parked();

    function Switching() {
      const [id, setId] = useState("r-1");
      return (
        <>
          <button type="button" onClick={() => setId("r-2")}>
            next
          </button>
          <Lookup request={{ resourceType: "doc", actions: ["read"], resourceIds: [id] }} />
        </>
      );
    }

    render(
      <Provider transport={transport}>
        <Switching />
      </Provider>,
    );
    await settle();
    await act(async () => menus[0]?.resolve(menuOf(["read", "PERMIT"])));
    await settle();
    await act(async () => screen.getByRole("button").click());
    await settle();
    expect(decisions.map((d) => d.request.resourceIds)).toEqual([["r-1"], ["r-2"]]);

    const [first, second] = decisions;
    await act(async () => second?.answer.resolve(answerAll(second.request, "PERMIT")));
    await settle();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=PERMIT/true|loading=false");

    await act(async () => first?.answer.resolve(answerAll(first.request, "PERMIT")));
    await settle();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=PERMIT/true|loading=false");
  });

  it("answered in the order asked: the earlier answer is not used, and the later one is", async () => {
    const { transport, menus, decisions } = parked();

    function Switching() {
      const [id, setId] = useState("r-1");
      return (
        <>
          <button type="button" onClick={() => setId("r-2")}>
            next
          </button>
          <Lookup request={{ resourceType: "doc", actions: ["read"], resourceIds: [id] }} />
        </>
      );
    }

    render(
      <Provider transport={transport}>
        <Switching />
      </Provider>,
    );
    await settle();
    await act(async () => menus[0]?.resolve(menuOf(["read", "PERMIT"])));
    await settle();
    await act(async () => screen.getByRole("button").click());
    await settle();

    const [first, second] = decisions;
    await act(async () => first?.answer.resolve(answerAll(first.request, "PERMIT")));
    await settle();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=true");

    await act(async () => second?.answer.resolve(answerAll(second.request, "PERMIT")));
    await settle();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=PERMIT/true|loading=false");
  });
});

describe("useDecisions identifies a request by its content", () => {
  function Rerendering({ ids }: { ids: (renders: number) => string[] }) {
    const [renders, setRenders] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setRenders((n) => n + 1)}>
          again
        </button>
        <Lookup request={{ resourceType: "doc", actions: ["read"], resourceIds: ids(renders) }} />
      </>
    );
  }

  it("an equal request written inline, rendered six times, is asked once", async () => {
    const { transport, menus } = parked();
    render(
      <Provider transport={transport}>
        <Rerendering ids={() => ["r-1"]} />
      </Provider>,
    );
    await settle();
    await act(async () => menus[0]?.resolve(menuOf(["read", "PERMIT"])));
    await settle();
    for (let i = 0; i < 5; i += 1) {
      await act(async () => screen.getByRole("button").click());
    }
    await settle();

    expect(transport.fetchDecisions).toHaveBeenCalledTimes(1);
    expect(built.permissions[0]?.decide).toHaveBeenCalledTimes(1);
  });

  it("a request whose content changes is asked again", async () => {
    const { transport, menus } = parked();
    render(
      <Provider transport={transport}>
        <Rerendering ids={(renders) => [`r-${renders}`]} />
      </Provider>,
    );
    await settle();
    await act(async () => menus[0]?.resolve(menuOf(["read", "PERMIT"])));
    await settle();
    await act(async () => screen.getByRole("button").click());
    await settle();

    expect(transport.fetchDecisions).toHaveBeenCalledTimes(2);
  });
});

describe("outside a provider, every hook throws", () => {
  const hooks: [string, () => unknown][] = [
    ["useAuthz", () => useAuthz()],
    ["useAuthzSession", () => useAuthzSession()],
    ["usePermissionEffect", () => usePermissionEffect("read")],
    ["usePermission", () => usePermission("read")],
    ["useDecisions", () => useDecisions(READ_R1)],
    ["PermissionGuard", () => PermissionGuard({ action: "read", children: null })],
  ];

  it.each(hooks)("%s throws instead of answering", (name, call) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Alone() {
      call();
      return null;
    }
    // Both read the menu through `usePermissionEffect`, so that is the name the message carries.
    const hook = name === "PermissionGuard" || name === "usePermission" ? "usePermissionEffect" : name;
    expect(() => render(<Alone />)).toThrow(`${hook}() must be called inside <AuthzProvider>`);
  });
});

describe("the provider closes its session on unmount", () => {
  it("a session without contexts is closed once", async () => {
    const view = render(
      <Provider transport={answering(menuOf(["read", "PERMIT"]))}>
        <Status />
      </Provider>,
    );
    await settle();
    expect(built.permissions[0]?.close).not.toHaveBeenCalled();

    view.unmount();
    expect(built.permissions).toHaveLength(1);
    expect(built.permissions[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("a context session is closed once, and the permissions session it built with it", async () => {
    const view = render(
      <Provider transport={answering(menuOf(["read", "PERMIT"]))} contextTransport={listing(context("a"))}>
        <Status />
      </Provider>,
    );
    await settle();
    expect(text("status")).toBe("READY|a|a|1");

    view.unmount();
    expect(built.contexts).toHaveLength(1);
    expect(built.contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(built.permissions[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("under StrictMode one started session stays open, and every started session is closed once by unmount", async () => {
    const view = render(
      <StrictMode>
        <Provider transport={answering(menuOf(["read", "PERMIT"]))}>
          <Status />
        </Provider>
      </StrictMode>,
    );
    await settle();
    expect(text("status")).toBe("READY|-||1");

    const started = () => built.permissions.filter((s) => s.start.mock.calls.length > 0);
    expect(started().every((s) => s.start.mock.calls.length === 1)).toBe(true);
    expect(started().filter((s) => s.close.mock.calls.length === 0)).toHaveLength(1);

    view.unmount();
    expect(started().every((s) => s.close.mock.calls.length === 1)).toBe(true);
  });
});

describe("the contexts survive entering a context, and come from lastListedContexts()", () => {
  it("entering a context keeps the list, element for element what lastListedContexts() returns", async () => {
    const setup = twoContexts();
    const api: { current?: Api } = {};
    render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} />
        <Status />
      </Provider>,
    );
    await settle();
    await act(async () => api.current?.selectContext("a"));
    await settle();

    expect(text("status")).toBe("READY|a|a,b|1");
    const listed = built.contexts[0]?.lastListedContexts() ?? [];
    expect(api.current?.contexts).toHaveLength(2);
    api.current?.contexts.forEach((element, index) => expect(element).toBe(listed[index]));
  });

  it("a later listing that fails leaves no list, even after a context was entered", async () => {
    let listings = 0;
    const contextTransport: ContextTransport = {
      listContexts: async () => {
        listings += 1;
        if (listings > 1) {
          throw new Error("unreachable");
        }
        return [context("a"), context("b")];
      },
    };
    const api: { current?: Api } = {};
    const session: { current?: unknown } = {};
    render(
      <Provider transport={twoContexts().transport} contextTransport={contextTransport}>
        <Capture api={api} session={session} />
        <Status />
      </Provider>,
    );
    await settle();
    await act(async () => api.current?.selectContext("a"));
    await settle();
    expect(text("status")).toBe("READY|a|a,b|1");

    await act(async () => (session.current as ContextSession).start());
    await settle();
    expect(text("status")).toBe("UNAVAILABLE|-||0");
  });
});

describe("what the provider passes through", () => {
  it("onDiagnostic reaches every permissions session it builds, and the context session does not use it", async () => {
    const kinds: string[] = [];
    const setup = twoContexts();
    const api: { current?: Api } = {};
    render(
      <Provider
        transport={setup.transport}
        contextTransport={setup.contextTransport}
        onDiagnostic={(event) => kinds.push(event.kind)}
      >
        <Capture api={api} />
      </Provider>,
    );
    await settle();
    await act(async () => api.current?.selectContext("a"));
    await settle();
    await act(async () => api.current?.selectContext("b"));
    await settle();

    expect(kinds.filter((kind) => kind === "menu-requested")).toHaveLength(2);
    expect(kinds).not.toContain("session-built");
  });

  it("a transport factory is called once for each permissions session built, with its context", async () => {
    const setup = twoContexts();
    const api: { current?: Api } = {};
    render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} />
      </Provider>,
    );
    await settle();
    for (const id of ["a", "b", "a"]) {
      await act(async () => api.current?.selectContext(id));
      await settle();
    }
    expect(setup.factoryCalls).toEqual(["a", "b", "a"]);
    expect(built.permissions).toHaveLength(3);
  });

  it("selectContext() rejects with a RangeError on a provider given no contextTransport", async () => {
    const api: { current?: Api } = {};
    render(
      <Provider transport={answering(menuOf(["read", "PERMIT"]))}>
        <Capture api={api} />
      </Provider>,
    );
    await settle();
    await expect(api.current?.selectContext("a")).rejects.toThrow(RangeError);
  });

  it("selectContext() on a session an effect's cleanup has closed rejects, and enters no context", async () => {
    const setup = twoContexts();
    const api: { current?: Api } = {};
    const view = render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} />
        <Status />
      </Provider>,
    );
    await settle();
    expect(text("status")).toBe("CHOOSING_CONTEXT|-|a,b|0");
    const closed = built.contexts[0];
    const held = api.current!;

    // Unmounting runs the cleanup of the effect that started the session, and that cleanup closes it.
    view.unmount();
    expect(closed?.close).toHaveBeenCalledTimes(1);

    let outcome: unknown = "resolved";
    await act(async () => {
      outcome = await held.selectContext("b").then(
        () => "resolved",
        (error: unknown) => error,
      );
    });
    expect(outcome).toBeInstanceOf(RangeError);
    expect(closed?.getState()).toMatchObject({ status: "IDLE" });
    expect(setup.factoryCalls).toEqual([]);
    expect(built.permissions).toHaveLength(0);
  });

  it("selectContext() in the same handler as a change of app rejects, and enters no context", async () => {
    const setup = twoContexts();
    const api: { current?: Api } = {};
    const changeApp: { current?: (app: string) => void } = {};
    function Switchable() {
      const [app, setApp] = useState(APP);
      changeApp.current = setApp;
      return (
        <Provider app={app} transport={setup.transport} contextTransport={setup.contextTransport}>
          <Capture api={api} />
          <Status />
        </Provider>
      );
    }
    render(<Switchable />);
    await settle();
    await act(async () => api.current?.selectContext("a"));
    await settle();
    expect(text("status")).toBe("READY|a|a,b|1");

    let outcome: unknown = "resolved";
    await act(async () => {
      const held = api.current!;
      changeApp.current?.("app-b");
      outcome = await held.selectContext("b").then(
        () => "resolved",
        (error: unknown) => error,
      );
    });
    expect(outcome).toBeInstanceOf(RangeError);

    await settle();
    expect(built.contexts).toHaveLength(2);
    expect(built.contexts[1]?.getState()).toMatchObject({ status: "CHOOSING_CONTEXT" });
    expect(api.current?.contextId).toBeUndefined();
    expect(text("status")).toBe("CHOOSING_CONTEXT|-|a,b|0");
  });

  it("without maxPairsPerRequest, a lookup answers DENY and nothing is thrown", async () => {
    const transport = answering(menuOf(["read", "PERMIT"]));
    render(
      <Provider transport={transport} maxPairsPerRequest={null}>
        <Status />
        <Lookup request={READ_R1} />
      </Provider>,
    );
    await settle();
    expect(text("status")).toBe("READY|-||1");
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=false");
    expect(built.permissions[0]?.decide).toHaveBeenCalledTimes(1);
    await expect(built.permissions[0]?.decide(READ_R1)).rejects.toThrow(RangeError);
    expect(transport.fetchDecisions).not.toHaveBeenCalled();
  });

  it("maxCachedDecisions reaches the session: a value the core refuses is refused when the provider renders", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <AuthzProvider app={APP} transport={answering(menuOf())} maxPairsPerRequest={10} maxCachedDecisions={0}>
          {null}
        </AuthzProvider>,
      ),
    ).toThrow("maxCachedDecisions must be an integer");
  });

  const rebuilding: [string, Partial<{ maxPairsPerRequest: number; maxCachedDecisions: number; contextTransport: ContextTransport }>][] = [
    ["maxPairsPerRequest", { maxPairsPerRequest: 20 }],
    ["maxCachedDecisions", { maxCachedDecisions: 20 }],
    ["whether contextTransport is given", { contextTransport: listing(context("a")) }],
  ];

  it.each(rebuilding)("a change to %s builds a new session and closes the one it replaces", async (_prop, change) => {
    const transport = answering(menuOf(["read", "PERMIT"]));
    const view = render(
      <AuthzProvider app={APP} transport={transport} maxPairsPerRequest={10} maxCachedDecisions={10}>
        <Status />
      </AuthzProvider>,
    );
    await settle();
    view.rerender(
      <AuthzProvider app={APP} transport={transport} maxPairsPerRequest={10} maxCachedDecisions={10} {...change}>
        <Status />
      </AuthzProvider>,
    );
    await settle();

    // The session the provider built first, and the one it built after the change.
    const [replaced, replacing] =
      change.contextTransport === undefined ? built.permissions : [built.permissions[0], built.contexts[0]];
    expect(replaced?.close).toHaveBeenCalledTimes(1);
    expect(replacing?.start).toHaveBeenCalledTimes(1);
    expect(replacing?.close).not.toHaveBeenCalled();
    expect(text("status")).toBe(change.contextTransport === undefined ? "READY|-||1" : "READY|a|a|1");
  });

  it("a new onDiagnostic and a new contextTransport are used by the next session built, and build none", async () => {
    const firstKinds: string[] = [];
    const secondKinds: string[] = [];
    const secondListing = vi.fn(async () => [context("b")]);
    const transport = answering(menuOf(["read", "PERMIT"]));
    const api: { current?: Api } = {};
    const view = render(
      <Provider transport={transport} contextTransport={listing(context("a"))} onDiagnostic={(e) => firstKinds.push(e.kind)}>
        <Capture api={api} />
        <Status />
      </Provider>,
    );
    await settle();
    view.rerender(
      <Provider
        transport={transport}
        contextTransport={{ listContexts: secondListing }}
        onDiagnostic={(e) => secondKinds.push(e.kind)}
      >
        <Capture api={api} />
        <Status />
      </Provider>,
    );
    await settle();
    expect(built.contexts).toHaveLength(1);
    expect(secondListing).not.toHaveBeenCalled();
    expect(text("status")).toBe("READY|a|a|1");

    await act(async () => {
      void api.current?.refresh();
    });
    await settle();
    expect(built.contexts).toHaveLength(2);
    expect(secondListing).toHaveBeenCalledTimes(1);
    expect(text("status")).toBe("READY|b|b|1");
    expect(firstKinds).toEqual(["menu-requested"]);
    expect(secondKinds).toEqual(["menu-requested"]);
  });

  it("a subject with no context is NO_CONTEXTS, and answers closed", async () => {
    const transport = answering(menuOf(["read", "PERMIT"]));
    render(
      <Provider transport={transport} contextTransport={listing()}>
        <Everything />
      </Provider>,
    );
    await settle();
    expect(text("status")).toBe("NO_CONTEXTS|-||0");
    expect(text("menu-read")).toBe("DENY/false");
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=false");
  });

  it("selectContext() settles once the context is entered", async () => {
    const setup = twoContexts({ parkMenuOfB: true });
    const api: { current?: Api } = {};
    const session: { current?: unknown } = {};
    render(
      <Provider transport={setup.transport} contextTransport={setup.contextTransport}>
        <Capture api={api} session={session} />
        <Status />
      </Provider>,
    );
    await settle();
    expect(session.current).toBe(built.contexts[0]);

    let entered = false;
    await act(async () => {
      void api.current?.selectContext("b").then(() => {
        entered = true;
      });
    });
    await settle();
    expect(text("status")).toBe("LOADING|b|a,b|0");
    expect(entered).toBe(false);

    await act(async () => setup.heldMenus[0]?.resolve(menuOf(["read", "PERMIT"])));
    await settle();
    expect(text("status")).toBe("READY|b|a,b|1");
    expect(entered).toBe(true);
  });

  it("a new transport is used by the next session built, and builds none itself", async () => {
    const first = answering(menuOf(["read", "PERMIT"]));
    const second = answering(menuOf(["read", "PERMIT"]), "CONDITIONAL");
    const api: { current?: Api } = {};
    const view = render(
      <Provider transport={first}>
        <Capture api={api} />
        <Lookup request={READ_R1} />
      </Provider>,
    );
    await settle();
    view.rerender(
      <Provider transport={second}>
        <Capture api={api} />
        <Lookup request={{ resourceType: "doc", actions: ["read"], resourceIds: ["r-2"] }} />
      </Provider>,
    );
    await settle();
    expect(built.permissions).toHaveLength(1);
    expect(text("lookup")).toBe("r-1=DENY/false r-2=PERMIT/true|loading=false");
    expect(second.fetchPermissions).not.toHaveBeenCalled();
    expect(second.fetchDecisions).not.toHaveBeenCalled();

    await act(async () => {
      void api.current?.refresh();
    });
    await settle();
    expect(built.permissions).toHaveLength(2);
    expect(second.fetchPermissions).toHaveBeenCalledTimes(1);
    expect(text("lookup")).toBe("r-1=DENY/false r-2=CONDITIONAL/true|loading=false");
  });

  it("a null request asks nothing and answers DENY", async () => {
    const transport = answering(menuOf(["read", "PERMIT"]));
    render(
      <Provider transport={transport}>
        <Lookup request={null} />
      </Provider>,
    );
    await settle();
    expect(text("lookup")).toBe("r-1=DENY/false r-2=DENY/false|loading=false");
    expect(transport.fetchDecisions).not.toHaveBeenCalled();
  });

  it("refresh() after unmount settles and builds nothing", async () => {
    const api: { current?: Api } = {};
    const view = render(
      <Provider transport={answering(menuOf(["read", "PERMIT"]))}>
        <Capture api={api} />
      </Provider>,
    );
    await settle();
    view.unmount();
    await expect(api.current?.refresh()).resolves.toBeUndefined();
    expect(built.permissions).toHaveLength(1);
  });

  it("a new app builds a new session and closes the previous one", async () => {
    const transport: AuthorizationTransport = {
      fetchPermissions: async (app) => ({ app, permissions: [{ action: "read", effect: "PERMIT" }] }),
      fetchDecisions: async (app) => ({ app, decisions: [] }),
    };
    const view = render(
      <Provider transport={transport}>
        <Status />
      </Provider>,
    );
    await settle();
    view.rerender(
      <Provider transport={transport} app="app-b">
        <Status />
      </Provider>,
    );
    await settle();

    expect(built.permissions).toHaveLength(2);
    expect(built.permissions[0]?.close).toHaveBeenCalledTimes(1);
    expect(built.permissions[1]?.close).not.toHaveBeenCalled();
    expect(text("status")).toBe("READY|-||1");
  });
});
