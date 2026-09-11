import { describe, expect, it, vi } from "vitest";

import type {
  AuthorizationSession,
  AuthorizationState,
  Decision,
  DecisionRequest,
} from "@ricardoqmd/authz-core";

import type { AuthorizationContext, ContextTransport } from "./context.js";
import { createContextSession, type ContextSession } from "./session.js";

/**
 * The doubles are built here, inline, and nothing like them ships in `src`. A mock session that
 * lived in the package would eventually be imported by a consumer "just for development" and would
 * answer `PERMIT` in production.
 */

const APP = "app-a";

const REQUEST: DecisionRequest = {
  resourceType: "orders",
  actions: ["read"],
  resourceIds: ["r-1"],
};

const PERMIT: Decision = { action: "read", resourceId: "r-1", effect: "PERMIT" };

function context(contextId: string, hasAccess = true): AuthorizationContext {
  return { contextId, label: contextId, hasAccess };
}

/** A promise whose settlement this test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-resolved microtask run before the assertions. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A permissions session double, recording what this layer did to it. */
function fakeSession(
  contextId: string,
  over: {
    decide?: (request: DecisionRequest) => Promise<readonly Decision[]>;
    start?: () => Promise<void>;
    readyState?: AuthorizationState;
  } = {},
) {
  let state: AuthorizationState = { status: "IDLE" };
  const listeners = new Set<(s: AuthorizationState) => void>();
  const closed = { value: false };
  const emit = (next: AuthorizationState) => {
    state = next;
    for (const l of listeners) l(next);
  };
  const session: AuthorizationSession = {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start:
      over.start ??
      (async () => {
        emit({ status: "LOADING" });
        emit(
          over.readyState ?? {
            status: "READY",
            permissions: [{ action: "read", effect: "PERMIT" }],
          },
        );
      }),
    decide: over.decide ?? (async () => [PERMIT]),
    close: () => {
      closed.value = true;
      listeners.clear();
      emit({ status: "IDLE" });
    },
  };
  return { session, closed, emit, contextId };
}

function transportFor(list: readonly AuthorizationContext[] | (() => Promise<never>)) {
  const calls: string[] = [];
  const contextTransport: ContextTransport = {
    listContexts: async (app) => {
      calls.push(app);
      if (typeof list === "function") return list();
      return list;
    },
  };
  return { contextTransport, calls };
}

function build(
  list: readonly AuthorizationContext[] | (() => Promise<never>),
  factory?: (contextId: string) => AuthorizationSession,
): { session: ContextSession; built: string[] } {
  const built: string[] = [];
  const { contextTransport } = transportFor(list);
  const session = createContextSession({
    app: APP,
    contextTransport,
    buildSession: (contextId) => {
      built.push(contextId);
      return (factory ?? ((id: string) => fakeSession(id).session))(contextId);
    },
  });
  return { session, built };
}

/* 1 — listing ------------------------------------------------------------- */

describe("start() lists the contexts and settles", () => {
  it("zero contexts -> NO_CONTEXTS, and no session is built", async () => {
    const { session, built } = build([]);
    await session.start();

    expect(session.getState()).toEqual({ status: "NO_CONTEXTS" });
    expect(built).toEqual([]);
  });

  it("exactly one context is activated with no picker: one context is not a choice", async () => {
    const seen: string[] = [];
    const { session, built } = build([context("ctx-a")]);
    session.subscribe((s) => seen.push(s.status));

    await session.start();

    expect(seen).not.toContain("CHOOSING_CONTEXT");
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-a" });
    expect(built).toEqual(["ctx-a"]);
  });

  it("two or more contexts -> CHOOSING_CONTEXT, and no session is built yet", async () => {
    const { session, built } = build([context("ctx-a"), context("ctx-b")]);
    await session.start();

    expect(session.getState()).toEqual({
      status: "CHOOSING_CONTEXT",
      contexts: [context("ctx-a"), context("ctx-b")],
    });
    expect(built).toEqual([]);
  });

  it("a listing that rejects -> UNAVAILABLE, which is NOT the permissions UNAVAILABLE", async () => {
    const { session } = build(async () => {
      throw new Error("the decision point is down");
    });
    await session.start();

    expect(session.getState()).toEqual({ status: "UNAVAILABLE" });
  });
});

/* 2 — no access ----------------------------------------------------------- */

describe("a context without access", () => {
  it("builds NO SESSION AT ALL, and the state carries the list so there is a way out", async () => {
    const contexts = [context("ctx-a", false), context("ctx-b")];
    const { session, built } = build(contexts);
    await session.start();
    await session.selectContext("ctx-a");

    // The factory is never called: asking and inferring "no access" from an empty answer confuses
    // two different screens.
    expect(built).toEqual([]);
    expect(session.getState()).toEqual({
      status: "NO_ACCESS_IN_APP",
      contextId: "ctx-a",
      contexts,
    });
  });

  it("answers [] from decide(), because there is no session to ask", async () => {
    const { session } = build([context("ctx-a", false), context("ctx-b")]);
    await session.start();
    await session.selectContext("ctx-a");

    expect(await session.decide(REQUEST)).toEqual([]);
  });
});

/* 3 — switching ----------------------------------------------------------- */

describe("switching contexts", () => {
  it("closes the outgoing session and discards it", async () => {
    const doubles = new Map<string, ReturnType<typeof fakeSession>>();
    const { session } = build([context("ctx-a"), context("ctx-b")], (id) => {
      const d = fakeSession(id);
      doubles.set(id, d);
      return d.session;
    });
    await session.start();
    await session.selectContext("ctx-a");
    expect(doubles.get("ctx-a")?.closed.value).toBe(false);

    await session.selectContext("ctx-b");

    expect(doubles.get("ctx-a")?.closed.value).toBe(true);
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-b" });
  });

  it("the discarded session cannot serve the new context: a fresh one is built", async () => {
    const asked: string[] = [];
    const { session, built } = build([context("ctx-a"), context("ctx-b")], (id) =>
      fakeSession(id, {
        decide: async () => {
          asked.push(id);
          return [PERMIT];
        },
      }).session,
    );
    await session.start();
    await session.selectContext("ctx-a");
    await session.decide(REQUEST);
    await session.selectContext("ctx-b");
    await session.decide(REQUEST);

    // Two distinct sessions, two distinct caches: nothing from ctx-a answered under ctx-b.
    expect(built).toEqual(["ctx-a", "ctx-b"]);
    expect(asked).toEqual(["ctx-a", "ctx-b"]);
  });

  it("switching back re-builds and re-asks: the session was discarded, not kept warm", async () => {
    const { session, built } = build([context("ctx-a"), context("ctx-b")]);
    await session.start();
    await session.selectContext("ctx-a");
    await session.selectContext("ctx-b");
    await session.selectContext("ctx-a");

    expect(built).toEqual(["ctx-a", "ctx-b", "ctx-a"]);
  });
});

/* 4 — 🔴 THE SEAM --------------------------------------------------------- */

describe("the seam: a context change supersedes what the core cannot see", () => {
  it("a decide() in flight under ctx-a that resolves after a switch returns []", async () => {
    const parked = deferred<readonly Decision[]>();
    const { session } = build([context("ctx-a"), context("ctx-b")], (id) =>
      fakeSession(id, {
        decide: id === "ctx-a" ? async () => parked.promise : async () => [PERMIT],
      }).session,
    );
    await session.start();
    await session.selectContext("ctx-a");

    const inFlight = session.decide(REQUEST);
    await settle();

    // The subject moves. The core cannot see this: `generation` is a per-session closure variable
    // and a context change is an event of another object entirely.
    await session.selectContext("ctx-b");

    // The parked answer resolves CORRECTLY — for ctx-a. Returning it now would paint ctx-a's
    // answers under ctx-b's label.
    parked.resolve([PERMIT]);

    expect(await inFlight).toEqual([]);
  });

  it("and it is not emitted under ctx-b's label either", async () => {
    const parked = deferred<void>();
    const seen: { status: string; contextId?: string }[] = [];
    const { session } = build([context("ctx-a"), context("ctx-b")], (id) =>
      fakeSession(id, {
        start: id === "ctx-a" ? async () => parked.promise : undefined,
      }).session,
    );
    await session.start();
    session.subscribe((s) =>
      seen.push({ status: s.status, contextId: "contextId" in s ? s.contextId : undefined }),
    );

    const activating = session.selectContext("ctx-a");
    await settle();
    await session.selectContext("ctx-b");
    parked.resolve();
    await activating;
    await settle();

    // Nothing after the switch names ctx-a, and the final state is ctx-b.
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-b" });
    const tail = seen.slice(seen.findIndex((e) => e.contextId === "ctx-b"));
    expect(tail.every((e) => e.contextId !== "ctx-a")).toBe(true);
  });

  it("a discarded session that keeps emitting does not paint its context back", async () => {
    // A session whose `unsubscribe` does NOT detach is a real shape — the core's own suite pins the
    // same one for its signal port — and it is the only way to reach this guard: `discardSession`
    // unsubscribes before closing, so a well-behaved double never fires afterwards. A consumer's
    // implementation is not obliged to be well-behaved.
    const emitters = new Map<string, (s: AuthorizationState) => void>();
    const { session } = build([context("ctx-a"), context("ctx-b")], (id) => {
      let state: AuthorizationState = { status: "IDLE" };
      const ls = new Set<(s: AuthorizationState) => void>();
      const emit = (next: AuthorizationState) => {
        state = next;
        for (const l of ls) l(next);
      };
      emitters.set(id, emit);
      return {
        getState: () => state,
        // The unsubscribe is a no-op: the listener stays attached for ever.
        subscribe: (l) => {
          ls.add(l);
          return () => {};
        },
        start: async () => emit({ status: "READY", permissions: [] }),
        decide: async () => [PERMIT],
        close: () => {},
      };
    });
    await session.start();
    await session.selectContext("ctx-a");
    await session.selectContext("ctx-b");

    // ctx-a's session, discarded but still holding this layer's listener, emits again.
    // Non-null on purpose: if the key is missing the test must FAIL, not quietly do nothing.
    // With `?.()` a renamed context id turns the whole assertion below into a no-op that passes.
    emitters.get("ctx-a")!({ status: "NO_ACCESS_IN_APP" });

    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-b" });
  });

  // ISOLATED SUPERSEDER: a selection, and nothing else. The first `start()` resolves before the
  // parked one begins, so it supersedes nothing; the only bump between the parked listing and its
  // resolution is `activate`'s. A test that superseded twice would stay green with either bump
  // removed and would prove nothing about either.
  it("a start() in flight that a SELECTION supersedes does not paint", async () => {
    const parked = deferred<readonly AuthorizationContext[]>();
    let call = 0;
    const contextTransport: ContextTransport = {
      listContexts: async () => {
        call += 1;
        return call === 1 ? [context("ctx-a"), context("ctx-b")] : parked.promise;
      },
    };
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: (id) => fakeSession(id).session,
    });

    await session.start();
    expect(session.getState().status).toBe("CHOOSING_CONTEXT");

    const superseded = session.start();
    await settle();
    await session.selectContext("ctx-b");

    parked.resolve([context("ctx-a")]);
    await superseded;
    await settle();

    // The superseded start() would otherwise have auto-activated its single context over ctx-b.
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-b" });
  });

  // ISOLATED SUPERSEDER: a selection, and nothing else. Same shape as the test above.
  it("a listing that REJECTS late, superseded by a SELECTION, does not paint UNAVAILABLE", async () => {
    const parked = deferred<readonly AuthorizationContext[]>();
    let call = 0;
    const contextTransport: ContextTransport = {
      listContexts: async () => {
        call += 1;
        return call === 1 ? [context("ctx-a"), context("ctx-b")] : parked.promise;
      },
    };
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: (id) => fakeSession(id).session,
    });

    await session.start();

    const superseded = session.start();
    await settle();
    await session.selectContext("ctx-a");

    parked.reject(new Error("too late"));
    await superseded;
    await settle();

    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-a" });
  });
});

/* 5 — the nested permissions state ---------------------------------------- */

describe("the permissions session surfaces nested, not flattened", () => {
  it("a permissions UNAVAILABLE surfaces under IN_CONTEXT, not as this layer's UNAVAILABLE", async () => {
    const { session } = build([context("ctx-a")], (id) =>
      fakeSession(id, { readyState: { status: "UNAVAILABLE" } }).session,
    );
    await session.start();

    // Two different meanings: "no context list" vs "a context whose menu failed".
    expect(session.getState()).toEqual({
      status: "IN_CONTEXT",
      contextId: "ctx-a",
      permissions: { status: "UNAVAILABLE" },
    });
  });

  it("re-emits the permissions session's own state changes while in context", async () => {
    let double!: ReturnType<typeof fakeSession>;
    const { session } = build([context("ctx-a")], (id) => {
      double = fakeSession(id);
      return double.session;
    });
    const seen: AuthorizationState[] = [];
    await session.start();
    session.subscribe((s) => {
      if (s.status === "IN_CONTEXT") seen.push(s.permissions);
    });

    double.emit({ status: "NO_ACCESS_IN_APP" });

    expect(seen).toContainEqual({ status: "NO_ACCESS_IN_APP" });
  });

  it("proxies decide() to the active session", async () => {
    const { session } = build([context("ctx-a")]);
    await session.start();

    expect(await session.decide(REQUEST)).toEqual([PERMIT]);
  });
});

/* 6 — close() ------------------------------------------------------------- */

describe("close()", () => {
  it("closes the active permissions session", async () => {
    let double!: ReturnType<typeof fakeSession>;
    const { session } = build([context("ctx-a")], (id) => {
      double = fakeSession(id);
      return double.session;
    });
    await session.start();

    session.close();

    expect(double.closed.value).toBe(true);
  });

  it("emits ONE final IDLE and only then drops the listeners", async () => {
    const seen: string[] = [];
    const { session } = build([context("ctx-a")]);
    await session.start();
    session.subscribe((s) => seen.push(s.status));

    session.close();
    expect(seen).toEqual(["IDLE"]);

    await session.start();
    expect(seen).toEqual(["IDLE"]);
  });

  it("a listener that re-enters start() from the final IDLE leaves the session IDLE", async () => {
    const { session, built } = build([context("ctx-a")]);
    await session.start();
    const before = built.length;

    let reentered: Promise<void> | undefined;
    session.subscribe((s) => {
      if (s.status === "IDLE" && reentered === undefined) {
        reentered = session.start();
      }
    });

    session.close();
    await reentered;
    await settle();

    expect(session.getState()).toEqual({ status: "IDLE" });
    expect(built.length).toBe(before);
  });

  it("a listener that re-enters close() from the final IDLE does not recurse", async () => {
    const { session } = build([context("ctx-a")]);
    await session.start();

    let emissions = 0;
    session.subscribe(() => {
      emissions += 1;
      session.close();
    });

    expect(() => session.close()).not.toThrow();
    expect(emissions).toBe(1);
  });

  it("is idempotent and inert afterwards", async () => {
    const { session, built } = build([context("ctx-a"), context("ctx-b")]);
    await session.start();
    const before = built.length;

    session.close();
    expect(() => session.close()).not.toThrow();

    await session.start();
    await session.selectContext("ctx-b");

    expect(built.length).toBe(before);
    expect(session.getState()).toEqual({ status: "IDLE" });
    expect(await session.decide(REQUEST)).toEqual([]);
  });

  it("subscribe() after close() registers nothing and its unsubscribe is safe", async () => {
    const { session } = build([context("ctx-a")]);
    await session.start();
    session.close();

    const late: string[] = [];
    const off = session.subscribe((s) => late.push(s.status));
    await session.start();

    expect(late).toEqual([]);
    expect(() => off()).not.toThrow();
  });
});

/* 7 — a listener cannot take the session down ----------------------------- */

describe("a subscribed listener cannot take the session down", () => {
  it("does not deny the emission to a listener subscribed after the thrower", async () => {
    const seen: string[] = [];
    const { session } = build([context("ctx-a"), context("ctx-b")]);
    session.subscribe(() => {
      throw new Error("render bug");
    });
    session.subscribe((s) => seen.push(s.status));

    await session.start();

    expect(seen).toEqual(["LOADING_CONTEXTS", "CHOOSING_CONTEXT"]);
  });

  it("does not break close(): the emission still reaches the listeners after the thrower", async () => {
    const seen: string[] = [];
    const { session } = build([context("ctx-a")]);
    await session.start();
    session.subscribe(() => {
      throw new Error("render bug");
    });
    session.subscribe((s) => seen.push(s.status));

    expect(() => session.close()).not.toThrow();

    expect(seen).toEqual(["IDLE"]);
    expect(() => session.close()).not.toThrow();
  });
});

/* 8 — the RangeError ------------------------------------------------------ */

describe("selectContext with an unknown id", () => {
  it("throws RangeError and leaves the state alone", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b")]);
    await session.start();
    const before = session.getState();

    await expect(session.selectContext("ctx-zzz")).rejects.toBeInstanceOf(RangeError);
    expect(session.getState()).toEqual(before);
  });

  it("does NOT throw once closed: inert means inert", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b")]);
    await session.start();
    session.close();

    await expect(session.selectContext("ctx-zzz")).resolves.toBeUndefined();
  });
});

/* 6 — the other two superseders: start() and close() ---------------------- */

/*
 * The suspension table in `session.ts` names THREE superseders on every row — a later start, a
 * select, and close() — and until now the suite exercised only the select. Both missing bumps were
 * measured: removing either left the whole suite green, and branch coverage was 100% while they
 * survived. Coverage sees a line run; it does not see WHICH answer the line let through.
 */

/** A session double whose decide() resolves only when the test releases it. */
function gatedSession(contextId: string) {
  const gate = deferred<readonly Decision[]>();
  const built = fakeSession(contextId, { decide: async () => gate.promise });
  return { ...built, release: () => gate.resolve([PERMIT]) };
}

describe("close() supersedes what is in flight", () => {
  /*
   * The leak, stated as the caller sees it: `discardSession()` clears the active session, but
   * `decide` already captured it in its closure. Without the bump the re-check waves the answer
   * through and a caller that has DESTROYED the session receives real PERMITs — which it will
   * render.
   */
  it("a decide() in flight when close() arrives returns [], not the PERMITs", async () => {
    const gated = gatedSession("ctx-a");
    const { session } = build([context("ctx-a")], () => gated.session);
    await session.start();
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-a" });

    const inFlight = session.decide(REQUEST);
    await settle();

    session.close();
    gated.release();

    expect(await inFlight).toEqual([]);
    expect(session.getState()).toEqual({ status: "IDLE" });
  });

  it("a start() in flight when close() arrives does not paint over the final IDLE", async () => {
    const parked = deferred<readonly AuthorizationContext[]>();
    const contextTransport: ContextTransport = { listContexts: () => parked.promise };
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: (id) => fakeSession(id).session,
    });

    const starting = session.start();
    session.close();
    parked.resolve([context("ctx-a")]);
    await starting;

    expect(session.getState()).toEqual({ status: "IDLE" });
  });
});

describe("start() supersedes what is in flight, on the multi-context path", () => {
  /*
   * Why the multi-context path specifically: with a single context, `start()` auto-selects and
   * `activate()` bumps the generation on its own, which covers the hole by accident. With two, a
   * re-start lands back at the picker and `activate()` never runs — so the only thing that can
   * supersede the in-flight decide() is start()'s own bump.
   */
  function twoContextsThenLanding(landing: "picker" | "none" | "unavailable") {
    const gated = gatedSession("ctx-a");
    let call = 0;
    const contextTransport: ContextTransport = {
      listContexts: async () => {
        call += 1;
        if (call === 1) return [context("ctx-a"), context("ctx-b")];
        if (landing === "picker") return [context("ctx-a"), context("ctx-b")];
        if (landing === "none") return [];
        throw new Error("the context service is down");
      },
    };
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: () => gated.session,
    });
    return { session, gated };
  }

  it("a re-start() landing at the picker discards a decide() from the context being left", async () => {
    const { session, gated } = twoContextsThenLanding("picker");
    await session.start();
    await session.selectContext("ctx-a");

    const inFlight = session.decide(REQUEST);
    await settle();

    await session.start();
    expect(session.getState()).toMatchObject({ status: "CHOOSING_CONTEXT" });

    // Without the bump these PERMITs are delivered with the subject in NO context at all.
    gated.release();
    expect(await inFlight).toEqual([]);
  });

  it("a re-start() landing at NO_CONTEXTS discards a decide() in flight", async () => {
    const { session, gated } = twoContextsThenLanding("none");
    await session.start();
    await session.selectContext("ctx-a");

    const inFlight = session.decide(REQUEST);
    await settle();

    await session.start();
    expect(session.getState()).toEqual({ status: "NO_CONTEXTS" });

    gated.release();
    expect(await inFlight).toEqual([]);
  });

  it("a re-start() landing at UNAVAILABLE discards a decide() in flight", async () => {
    const { session, gated } = twoContextsThenLanding("unavailable");
    await session.start();
    await session.selectContext("ctx-a");

    const inFlight = session.decide(REQUEST);
    await settle();

    await session.start();
    expect(session.getState()).toEqual({ status: "UNAVAILABLE" });

    gated.release();
    expect(await inFlight).toEqual([]);
  });

  /*
   * THE TWO LOCKUPS. Of the combinations this file's supersession table declares, these two are the
   * ones whose consequence is not a stale screen: the superseded listing overwrites or empties
   * `contexts`, and `selectContext()` then raises `RangeError` for a context the server DID return.
   * There is no way out of that state from inside the API — only a reload.
   *
   * ISOLATED SUPERSEDER in both: a second `start()`, and nothing else. No `selectContext()` runs
   * while the parked listing is still in flight, so `activate()`'s bump cannot stand in for
   * `start()`'s. The naming assertion comes first, and it reads the outcome of `selectContext()`
   * rather than awaiting it, so the failure is the assertion and not a rejected promise.
   */
  function parkedFirstListing() {
    const parked = deferred<readonly AuthorizationContext[]>();
    let call = 0;
    const contextTransport: ContextTransport = {
      listContexts: async () => {
        call += 1;
        return call === 1
          ? parked.promise
          : [context("ctx-a"), context("ctx-b"), context("ctx-c")];
      },
    };
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: (id) => fakeSession(id).session,
    });
    return { session, parked };
  }

  async function selectOutcome(session: ContextSession, contextId: string): Promise<string> {
    return session.selectContext(contextId).then(
      () => "selected",
      (error: unknown) => `${(error as Error).name}: ${(error as Error).message}`,
    );
  }

  it("a superseded listing that RESOLVES late does not lock ctx-c out of the picker", async () => {
    const { session, parked } = parkedFirstListing();

    const superseded = session.start();
    await settle();
    await session.start();
    expect(session.getState()).toMatchObject({ status: "CHOOSING_CONTEXT" });

    parked.resolve([context("ctx-a"), context("ctx-b")]);
    await superseded;
    await settle();

    // Without the re-check the abandoned two-context list is painted over the fresh three, and
    // ctx-c — which the server returned — cannot be selected any more.
    expect(await selectOutcome(session, "ctx-c")).toBe("selected");
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-c" });
  });

  it("a superseded listing that REJECTS late does not empty the list the re-start filled", async () => {
    const { session, parked } = parkedFirstListing();

    const superseded = session.start();
    await settle();
    await session.start();
    expect(session.getState()).toMatchObject({ status: "CHOOSING_CONTEXT" });

    parked.reject(new Error("the context service was down for the abandoned start"));
    await superseded;
    await settle();

    // Without the re-check the catch clears `contexts` and paints UNAVAILABLE, and every context
    // the successful re-start listed becomes unselectable.
    expect(await selectOutcome(session, "ctx-c")).toBe("selected");
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-c" });
  });
});

/* 7 — a consumer session that throws on the way out ----------------------- */

/*
 * The two try/catch blocks in `discardSession()` and the unsubscribe that `subscribe()` returns.
 * All three are guards on the boundary with consumer code: this layer holds a session object it did
 * not write, and a switch must not be hostage to that object's exit path.
 */

/** A session double whose exit path is hostile in exactly the way the test names. */
function hostileSession(
  // Accepted and ignored. `build`'s factory type is what requires the parameter; nothing about
  // being hostile on the way out depends on which context this double stands for.
  contextId: string,
  hostility: { unsubscribe?: boolean; close?: boolean } = {},
): AuthorizationSession {
  let state: AuthorizationState = { status: "IDLE" };
  const listeners = new Set<(s: AuthorizationState) => void>();
  return {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        if (hostility.unsubscribe) throw new Error("unsubscribe blew up");
        listeners.delete(l);
      };
    },
    start: async () => {
      state = { status: "READY", permissions: [{ action: "read", effect: "PERMIT" }] };
      for (const l of listeners) l(state);
    },
    decide: async () => [],
    close: () => {
      if (hostility.close) throw new Error("close blew up");
      listeners.clear();
    },
  };
}

describe("a consumer session that throws on the way out does not take this layer down", () => {
  it("an unsubscribe() that throws does not stop the context switch", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b")], (id) =>
      id === "ctx-a" ? hostileSession(id, { unsubscribe: true }) : hostileSession(id),
    );
    await session.start();
    await session.selectContext("ctx-a");

    await expect(session.selectContext("ctx-b")).resolves.toBeUndefined();
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-b" });
  });

  it("a close() that throws stops neither the switch nor this layer's own close()", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b")], (id) =>
      id === "ctx-a" ? hostileSession(id, { close: true }) : hostileSession(id),
    );
    await session.start();
    await session.selectContext("ctx-a");

    await expect(session.selectContext("ctx-b")).resolves.toBeUndefined();
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-b" });

    const second = build([context("ctx-a"), context("ctx-b")], (id) =>
      hostileSession(id, { close: true }),
    ).session;
    await second.start();
    await second.selectContext("ctx-a");

    expect(() => second.close()).not.toThrow();
    expect(second.getState()).toEqual({ status: "IDLE" });
  });
});

describe("subscribe() returns an unsubscribe that really detaches", () => {
  it("after calling it, the listener stops receiving emissions", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b")], (id) => hostileSession(id));
    const seen: string[] = [];
    const off = session.subscribe((st) => seen.push(st.status));

    await session.start();
    expect(seen.length).toBeGreaterThan(0);
    const atUnsubscribe = seen.length;

    off();
    await session.selectContext("ctx-a");
    session.close();

    expect(seen.length).toBe(atUnsubscribe);
  });
});

/* 8 — a failed start() holds no server truth ------------------------------ */

describe("a start() that fails clears the context list", () => {
  /*
   * `contexts` is server truth — the set the decision point said this subject holds. A start that
   * failed obtained none, so it keeps none.
   *
   * The consequence is where the subject finds out. The backend validates ownership on every call,
   * so a stale list grants nothing either way; but it lets `selectContext` build a session for a
   * context the server may no longer return, and that session looks real and denies everything.
   * With the list cleared the call raises instead, and the only way forward is a start that worked.
   */
  it("a later selectContext() raises instead of building a session on a stale list", async () => {
    let call = 0;
    const contextTransport: ContextTransport = {
      listContexts: async () => {
        call += 1;
        if (call === 1) return [context("ctx-a"), context("ctx-b")];
        throw new Error("the context service is down");
      },
    };
    const built: string[] = [];
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: (id) => {
        built.push(id);
        return fakeSession(id).session;
      },
    });

    await session.start();
    expect(session.getState()).toMatchObject({ status: "CHOOSING_CONTEXT" });

    await session.start();
    expect(session.getState()).toEqual({ status: "UNAVAILABLE" });

    // `selectContext` is async, so the RangeError arrives as a rejection rather than a synchronous
    // throw. Asserting it the other way passes vacuously and leaves an unhandled rejection behind.
    await expect(session.selectContext("ctx-a")).rejects.toThrow(RangeError);
    expect(built).toEqual([]);
  });
});

/* 9 — the optimistic paint --------------------------------------------------- */

describe("the optimistic paint", () => {
  /*
   * The `setState` in `activate()` that fires BEFORE `await session.start()`. It was measured
   * deletable with the whole suite green and coverage at 100 % on all four metrics — the same
   * lesson this file writes about the two generation bumps, in a third place.
   *
   * What it is NOT: an authorization guard. `decide()` is correct throughout the window, and the
   * enforcement point validates regardless. What it IS: the difference between a screen that
   * changes context when the subject chooses it and one that keeps the PREVIOUS context's label
   * and PREVIOUS context's menu painted — coherent with each other, and wrong — for as long as the
   * consumer's `start()` takes, while `decide()` already answers for the new context.
   *
   * The double emits only after its own `await`, which is what opens the window. A session that
   * emits before its first await — the core's own does — closes it on its own, so a double built
   * that way would make this test pass with the guard deleted.
   */
  function lateEmittingSession(contextId: string) {
    let state: AuthorizationState = { status: "IDLE" };
    const listeners = new Set<(s: AuthorizationState) => void>();
    const gate = deferred<void>();
    const session: AuthorizationSession = {
      getState: () => state,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      start: async () => {
        await gate.promise;
        state = {
          status: "READY",
          permissions: [{ action: contextId, effect: "PERMIT" }],
        };
        for (const l of listeners) l(state);
      },
      decide: async () => [PERMIT],
      close: () => listeners.clear(),
    };
    return { session, finish: () => gate.resolve() };
  }

  it("shows the NEW context while the consumer's start() is still in flight", async () => {
    const sessions = new Map<string, ReturnType<typeof lateEmittingSession>>();
    const { session } = build([context("ctx-a"), context("ctx-b")], (id) => {
      const made = lateEmittingSession(id);
      sessions.set(id, made);
      return made.session;
    });

    await session.start();

    // The double is created by buildSession, which only runs once activate() does — so it has to
    // be read AFTER the call starts, not before. Reading it first leaves `finish` uncalled and the
    // test fails on a timeout instead of on the assertion, which measures nothing.
    const selectingA = session.selectContext("ctx-a");
    await settle();
    sessions.get("ctx-a")!.finish();
    await selectingA;
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-a" });

    // The switch. Its start() is parked, so this is the window.
    const selectingB = session.selectContext("ctx-b");
    await settle();

    const during = session.getState();
    expect(during).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-b" });
    expect(during).not.toMatchObject({ contextId: "ctx-a" });

    sessions.get("ctx-b")!.finish();
    await selectingB;
  });
});
