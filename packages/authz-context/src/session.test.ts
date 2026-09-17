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

/* 4 — THE SEAM --------------------------------------------------------- */

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
 * Three events supersede a call in flight, as `session.ts` says above its suspension table — a later
 * start, a select, and close() — and each of them bumps the generation. The blocks below are about the
 * two that are not a select: what a call already in flight gives the caller once one of them lands.
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

/* — the context is read once, when it is activated ------------------------------- */

/*
 * The contexts a subject is shown are the objects the list arrived with, and the consumer holds them.
 * Changing one while its session starts must not change which context the screen says it is in: the
 * session was built for the context that was chosen, and every state painted for it carries that id —
 * the ones painted before the session settles, the ones its emissions paint, and the one after.
 */
describe("the context is read once, when it is activated", () => {
  it("a context id changed while its session starts does not relabel that session's states", async () => {
    const gate = deferred<void>();
    const { session, built } = build([context("ctx-a"), context("ctx-b")], (id) => {
      const made = fakeSession(id, {
        start: async () => {
          made.emit({ status: "LOADING" });
          await gate.promise;
          made.emit({ status: "READY", permissions: [{ action: "read", effect: "PERMIT" }] });
        },
      });
      return made.session;
    });
    const labels: string[] = [];
    session.subscribe((s) => {
      if (s.status === "IN_CONTEXT") {
        labels.push(`${s.contextId}/${s.permissions.status}`);
      }
    });
    await session.start();
    const shown = session.getState();
    const listed = shown.status === "CHOOSING_CONTEXT" ? shown.contexts : [];

    const selecting = session.selectContext("ctx-a");
    (listed[0] as { contextId: string }).contextId = "ctx-b";
    gate.resolve();
    await selecting;

    expect([built, labels]).toEqual([
      ["ctx-a"],
      ["ctx-a/IDLE", "ctx-a/LOADING", "ctx-a/READY", "ctx-a/READY"],
    ]);
  });
});

/* — a context list that is not a list of contexts ---------------------------------------------- */

describe("a context list that is not a list of contexts", () => {
  async function started(list: unknown): Promise<{ started: string; state: unknown; built: string[] }> {
    const { session, built } = build(list as readonly AuthorizationContext[]);
    const settled = await session.start().then(
      () => "resolved",
      (error: unknown) => `rejected ${String(error)}`,
    );
    return { started: settled, state: session.getState(), built };
  }

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "ctx-a"],
    ["an object", { contexts: [context("ctx-a")] }],
    ["a list holding only a null", [null]],
    ["a list holding only an object with no contextId", [{}]],
  ])("%s leaves the session UNAVAILABLE, not loading forever and not offering a picker", async (_name, list) => {
    expect(await started(list)).toEqual({ started: "resolved", state: { status: "UNAVAILABLE" }, built: [] });
  });

  it("an element that names no context is left out, and the context beside it is activated", async () => {
    const { started: s, state, built } = await started([null, context("ctx-b")]);

    expect([s, state, built]).toMatchObject(["resolved", { status: "IN_CONTEXT", contextId: "ctx-b" }, ["ctx-b"]]);
  });

  it("an empty list is still NO_CONTEXTS", async () => {
    expect(await started([])).toEqual({ started: "resolved", state: { status: "NO_CONTEXTS" }, built: [] });
  });

  it("after an unusable list, selecting a context the previous list offered is refused", async () => {
    let answer: unknown = [context("ctx-a"), context("ctx-b")];
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: async () => answer as readonly AuthorizationContext[] },
      buildSession: (id) => fakeSession(id).session,
    });
    await session.start();
    answer = null;
    await session.start().catch(() => undefined);

    const selected = await session.selectContext("ctx-a").then(
      () => "resolved",
      (error: unknown) => String(error),
    );

    expect([session.getState(), selected]).toEqual([{ status: "UNAVAILABLE" }, "RangeError: unknown contextId: ctx-a"]);
  });
});

/* — the screen belongs to the call that superseded the one in flight ---------------------------- */

/*
 * Three of the twelve pairs in the suspension table of `session.ts` — a suspension point and the
 * event that supersedes it — each pinned by what a consumer sees once the late answer arrives.
 */
describe("a superseded listing or activation leaves the screen of the call that superseded it", () => {
  it("a listing that rejects after close() leaves the session IDLE, not UNAVAILABLE", async () => {
    const parked = deferred<readonly AuthorizationContext[]>();
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: () => parked.promise },
      buildSession: (id) => fakeSession(id).session,
    });

    const starting = session.start();
    session.close();
    parked.reject(new Error("the decision point is down"));
    await starting;

    expect(session.getState()).toEqual({ status: "IDLE" });
  });

  it("a re-start() that lands while a context loads its menu shows the context the re-start chose", async () => {
    const parked = deferred<void>();
    const listings: (readonly AuthorizationContext[])[] = [[context("ctx-a")], [context("ctx-b")]];
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: async () => listings.shift() ?? [] },
      buildSession: (id) => fakeSession(id, { start: id === "ctx-a" ? async () => parked.promise : undefined }).session,
    });

    const first = session.start();
    await settle();
    await session.start();
    parked.resolve();
    await first;

    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-b" });
  });

  it("close() while a context loads its menu leaves the session IDLE, not in the context it left", async () => {
    const parked = deferred<void>();
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: async () => [context("ctx-a")] },
      buildSession: (id) => fakeSession(id, { start: async () => parked.promise }).session,
    });

    const first = session.start();
    await settle();
    session.close();
    parked.resolve();
    await first;

    expect(session.getState()).toEqual({ status: "IDLE" });
  });
});

describe("a context list that throws while it is read", () => {
  it("leaves the session UNAVAILABLE, not loading forever", async () => {
    const list = new Proxy([context("ctx-a")], {
      get(target, key, receiver) {
        if (key === "0") {
          throw new Error("not loaded");
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const { session } = build(list);

    const started = await session.start().then(
      () => "resolved",
      (error: unknown) => String(error),
    );

    expect([started, session.getState()]).toEqual(["resolved", { status: "UNAVAILABLE" }]);
  });
});

describe("a listener that subscribes during the final emission of close()", () => {
  it("receives nothing: the session is already closed when it subscribes", async () => {
    const { session } = build([context("ctx-a")]);
    await session.start();
    const heardByLate: string[] = [];
    session.subscribe((state) => {
      if (state.status === "IDLE") {
        session.subscribe((later) => heardByLate.push(later.status));
      }
    });

    session.close();

    expect(heardByLate).toEqual([]);
  });
});

describe("a context list holding an element that cannot be read", () => {
  const throwing = (field: string) =>
    Object.defineProperty({ ...context("ctx-x") }, field, {
      get() {
        throw new Error("not loaded");
      },
      enumerable: true,
    });

  it.each(["contextId", "hasAccess"])(
    "an element whose %s throws when read leaves the session UNAVAILABLE, not in the context beside it",
    async (field) => {
      const { session, built } = build([context("ctx-a"), throwing(field) as AuthorizationContext]);

      const started = await session.start().then(
        () => "resolved",
        (error: unknown) => String(error),
      );

      expect([started, session.getState().status, built]).toEqual(["resolved", "UNAVAILABLE", []]);
    },
  );

  it("an element that is a function carrying a context leaves the session UNAVAILABLE, not in the context beside it", async () => {
    const carried = Object.assign(function element() {}, context("ctx-x"));
    const { session, built } = build([context("ctx-a"), carried as unknown as AuthorizationContext]);

    await session.start();

    expect([session.getState().status, built]).toEqual(["UNAVAILABLE", []]);
  });

  it("a list that gains a context while it is read leaves the session UNAVAILABLE, not in the one it was read with", async () => {
    const list: AuthorizationContext[] = [context("ctx-a")];
    Object.defineProperty(list, 0, {
      get() {
        list.push(context("ctx-b"));
        return context("ctx-a");
      },
      enumerable: true,
      configurable: true,
    });
    const { session, built } = build(list);

    await session.start();

    expect([session.getState().status, built]).toEqual(["UNAVAILABLE", []]);
  });

  it("a single element whose hasAccess throws leaves the session UNAVAILABLE, not loading forever", async () => {
    const { session } = build([throwing("hasAccess") as AuthorizationContext]);

    const started = await session.start().then(
      () => "resolved",
      (error: unknown) => String(error),
    );

    expect([started, session.getState()]).toEqual(["resolved", { status: "UNAVAILABLE" }]);
  });
});

describe("a context listed more than once", () => {
  it.each([
    ["with access first", [context("ctx-a", true), context("ctx-a", false), context("ctx-b")]],
    ["without access first", [context("ctx-a", false), context("ctx-a", true), context("ctx-b")]],
  ])("is entered the way that says it does not open the application (%s)", async (_order, list) => {
    const { session, built } = build(list);
    await session.start();

    await session.selectContext("ctx-a");

    expect([session.getState().status, built]).toEqual(["NO_ACCESS_IN_APP", []]);
  });

  it("listed twice with access, is entered", async () => {
    const { session, built } = build([context("ctx-a"), context("ctx-a"), context("ctx-b")]);
    await session.start();

    await session.selectContext("ctx-a");

    expect([session.getState().status, built]).toEqual(["IN_CONTEXT", ["ctx-a"]]);
  });
});

/*
 * The elements a context list keeps are the ones that arrived, so a field of one can answer
 * differently each time it is read. Each element below answers one way the first time its field is
 * read and another way after that.
 */
describe("a context is entered as it read when the list was judged", () => {
  function answeringOnceThen(field: "contextId" | "hasAccess", first: unknown, then: unknown | Error): AuthorizationContext {
    let reads = 0;
    return Object.defineProperty({ ...context("ctx-a") }, field, {
      get() {
        reads += 1;
        if (reads === 1) {
          return first;
        }
        if (then instanceof Error) {
          throw then;
        }
        return then;
      },
      enumerable: true,
    });
  }

  it.each([
    ["a hasAccess that said no, then yes", answeringOnceThen("hasAccess", false, true), ["NO_ACCESS_IN_APP", "ctx-a", []]],
    ["a hasAccess that said yes, then throws", answeringOnceThen("hasAccess", true, new Error("second read")), ["IN_CONTEXT", "ctx-a", ["ctx-a"]]],
    ["a contextId that read ctx-a, then throws", answeringOnceThen("contextId", "ctx-a", new Error("second read")), ["IN_CONTEXT", "ctx-a", ["ctx-a"]]],
    ["a contextId that read ctx-a, then 42", answeringOnceThen("contextId", "ctx-a", 42), ["IN_CONTEXT", "ctx-a", ["ctx-a"]]],
  ] as const)("%s", async (_n, element, expected) => {
    const { session, built } = build([element]);

    const started = await session.start().then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    const state = session.getState();

    expect([started, state.status, "contextId" in state ? state.contextId : undefined, built]).toEqual(["resolved", ...expected]);
  });
});

/* — a value that is not an object is read the way an object is ------------------------------------- */

/*
 * An ordinary read of a field of a boolean goes through the prototype every boolean shares. This
 * gives it a context's fields for the duration of one listing, and takes them away before anything
 * is asserted.
 */
describe("a context list element that is not an object is read the way an object is", () => {
  async function withBooleanFields<T>(fields: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(Boolean.prototype, key, { value, writable: true, configurable: true });
    }
    try {
      return await run();
    } finally {
      for (const key of Object.keys(fields)) {
        delete (Boolean.prototype as unknown as Record<string, unknown>)[key];
      }
    }
  }

  it("a boolean whose read names a context is counted: the context beside it is not entered without a choice", async () => {
    const { session, built } = build([context("ctx-a"), true as unknown as AuthorizationContext]);

    await withBooleanFields({ contextId: "ctx-b", label: "ctx-b", hasAccess: true }, () => session.start());

    expect([session.getState().status, built]).toEqual(["CHOOSING_CONTEXT", []]);
  });

  it("a boolean whose read names no context is left out, and the context beside it is activated", async () => {
    const { session, built } = build([context("ctx-a"), true as unknown as AuthorizationContext]);

    await session.start();

    expect([session.getState().status, built]).toEqual(["IN_CONTEXT", ["ctx-a"]]);
  });
});

describe("the contexts as of the last listing, beside the state", () => {
  it("is undefined before any listing, and while the first one is in flight", async () => {
    const parked = deferred<readonly AuthorizationContext[]>();
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: () => parked.promise },
      buildSession: (id) => fakeSession(id).session,
    });

    const before = session.lastListedContexts();
    const starting = session.start();
    const during = session.lastListedContexts();
    parked.resolve([context("ctx-a"), context("ctx-b")]);
    await starting;

    expect([before, during, session.lastListedContexts()]).toEqual([
      undefined,
      undefined,
      [context("ctx-a"), context("ctx-b")],
    ]);
  });

  it("is an empty array after a listing that named no context", async () => {
    const { session } = build([]);

    await session.start();

    expect([session.getState().status, session.lastListedContexts()]).toEqual(["NO_CONTEXTS", []]);
  });

  it("stays the list once a context is chosen, where the state no longer carries it", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b")]);

    await session.start();
    await session.selectContext("ctx-b");

    expect(session.getState()).not.toHaveProperty("contexts");
    expect(session.lastListedContexts()).toEqual([context("ctx-a"), context("ctx-b")]);
  });

  it("holds the list on the single-context path, where no state ever carries it", async () => {
    const { session } = build([context("ctx-a")]);

    await session.start();

    expect([session.getState().status, session.lastListedContexts()]).toEqual(["IN_CONTEXT", [context("ctx-a")]]);
  });

  it("is undefined after a listing that failed, and after one that was not a list of contexts", async () => {
    const listings: (() => Promise<unknown>)[] = [
      async () => [context("ctx-a"), context("ctx-b")],
      async () => {
        throw new Error("the context service is down");
      },
      async () => [context("ctx-a"), context("ctx-b")],
      async () => ({ items: [context("ctx-a")] }),
    ];
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: () => (listings.shift() as () => Promise<never>)() },
      buildSession: (id) => fakeSession(id).session,
    });
    const seen: unknown[] = [];

    for (let i = 0; i < 4; i += 1) {
      await session.start();
      seen.push([session.getState().status, session.lastListedContexts()]);
    }

    expect(seen).toEqual([
      ["CHOOSING_CONTEXT", [context("ctx-a"), context("ctx-b")]],
      ["UNAVAILABLE", undefined],
      ["CHOOSING_CONTEXT", [context("ctx-a"), context("ctx-b")]],
      ["UNAVAILABLE", undefined],
    ]);
  });

  it("is undefined after close()", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b")]);

    await session.start();
    session.close();

    expect(session.lastListedContexts()).toBeUndefined();
  });

  it("keeps the last list while a later listing is in flight, and takes the new one when it ends", async () => {
    const second = deferred<readonly AuthorizationContext[]>();
    const listings: (() => Promise<readonly AuthorizationContext[]>)[] = [
      async () => [context("ctx-a"), context("ctx-b")],
      () => second.promise,
    ];
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: () => (listings.shift() as () => Promise<never>)() },
      buildSession: (id) => fakeSession(id).session,
    });

    await session.start();
    const restarting = session.start();
    const during = [session.getState().status, session.lastListedContexts()];
    second.resolve([context("ctx-c"), context("ctx-d")]);
    await restarting;

    expect(during).toEqual(["LOADING_CONTEXTS", [context("ctx-a"), context("ctx-b")]]);
    expect(session.lastListedContexts()).toEqual([context("ctx-c"), context("ctx-d")]);
  });

  it("a listing superseded by a later start() or by close() is not the last listing", async () => {
    const late = deferred<readonly AuthorizationContext[]>();
    const listings: (() => Promise<readonly AuthorizationContext[]>)[] = [
      () => late.promise,
      async () => [context("ctx-a"), context("ctx-b")],
    ];
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: () => (listings.shift() as () => Promise<never>)() },
      buildSession: (id) => fakeSession(id).session,
    });
    const closedLate = deferred<readonly AuthorizationContext[]>();
    const closing = createContextSession({
      app: APP,
      contextTransport: { listContexts: () => closedLate.promise },
      buildSession: (id) => fakeSession(id).session,
    });

    const first = session.start();
    await session.start();
    late.resolve([context("ctx-z")]);
    await first;
    const closingStart = closing.start();
    closing.close();
    closedLate.resolve([context("ctx-z"), context("ctx-y")]);
    await closingStart;

    expect([session.lastListedContexts(), closing.lastListedContexts()]).toEqual([
      [context("ctx-a"), context("ctx-b")],
      undefined,
    ]);
  });

  it("returns a new array each call: what a caller does to one reaches neither the next call nor a later state", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b"), context("ctx-c", false)]);
    await session.start();

    const first = session.lastListedContexts() as AuthorizationContext[];
    first.pop();
    first.push(context("ctx-planted"));
    const second = session.lastListedContexts();
    await session.selectContext("ctx-c");

    expect(second).not.toBe(first);
    expect(second).toEqual([context("ctx-a"), context("ctx-b"), context("ctx-c", false)]);
    expect(session.getState()).toMatchObject({
      status: "NO_ACCESS_IN_APP",
      contexts: [context("ctx-a"), context("ctx-b"), context("ctx-c", false)],
    });
  });

  it("its elements are the contexts as the listing returned them, the same objects a state carrying contexts holds", async () => {
    const listed = [context("ctx-a"), context("ctx-b")];
    const { session } = build(listed);

    await session.start();
    const state = session.getState() as { contexts: readonly AuthorizationContext[] };
    const last = session.lastListedContexts() as readonly AuthorizationContext[];

    expect([last[0] === listed[0], last[1] === listed[1], last[0] === state.contexts[0]]).toEqual([true, true, true]);
  });

  it("already holds the list when the state that follows the listing is emitted", async () => {
    const { session } = build([context("ctx-a"), context("ctx-b")]);
    const heard: unknown[] = [];
    session.subscribe((state) => heard.push([state.status, session.lastListedContexts()]));

    await session.start();

    expect(heard).toEqual([
      ["LOADING_CONTEXTS", undefined],
      ["CHOOSING_CONTEXT", [context("ctx-a"), context("ctx-b")]],
    ]);
  });

  it("leaves out an element that names no context, as the state does", async () => {
    const { session } = build([context("ctx-a"), { label: "none" } as unknown as AuthorizationContext, context("ctx-b")]);

    await session.start();

    expect(session.lastListedContexts()).toEqual((session.getState() as { contexts: unknown }).contexts);
    expect(session.lastListedContexts()).toEqual([context("ctx-a"), context("ctx-b")]);
  });
});
