import { describe, expect, it, vi } from "vitest";

import { decisionFor } from "./decision.js";
import type { ContextSignal, ContextStore } from "./context-sync.js";
import {
  createAuthorizationSession,
  type AuthorizationSessionOptions,
  type AuthorizationState,
} from "./session.js";
import type {
  AuthorizationContext,
  AuthorizationTransport,
  DecisionSet,
  PermissionMenu,
} from "./transport.js";

/**
 * The two ports, exercised with fakes built here.
 *
 * **No browser API and no fake DOM.** The core stays environment-free and these tests are the
 * evidence: an in-memory store and a signal the test drives by hand are enough to pin every rule,
 * and the browser implementations are a separate package.
 *
 * The proof that a session built WITHOUT these ports is unchanged is not in this file — it is that
 * all 59 tests of the frozen `session.test.ts` still pass with no edit.
 */

const APP = "app-a";

function context(contextId: string, hasAccess = true): AuthorizationContext {
  return { contextId, label: contextId, hasAccess };
}

function menu(contextId: string, actions: readonly string[] = ["read"]): PermissionMenu {
  return {
    app: APP,
    contextId,
    permissions: actions.map((action) => ({ action, effect: "PERMIT" as const })),
  };
}

/** A promise whose settlement this test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets every already-resolved microtask run before the assertions. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** An in-memory store. Nothing here touches a browser. */
function memoryStore(initial: string | null = null) {
  let value = initial;
  const store: ContextStore = {
    read: () => value,
    write: (contextId) => {
      value = contextId;
    },
    clear: () => {
      value = null;
    },
  };
  return {
    store,
    read: () => value,
    clearSpy: vi.spyOn(store, "clear"),
  };
}

/** A signal the test drives: `announce` records, and `fire` plays the part of another tab. */
function driverSignal(options: { unsubscribeDetaches?: boolean } = {}) {
  const { unsubscribeDetaches = true } = options;
  const announced: string[] = [];
  let listener: ((contextId: string) => void) | undefined;
  // A channel whose `unsubscribe` does NOT detach is a real shape — and it is the only way to
  // prove the session goes inert on its own rather than relying on the port to stop calling it.
  const unsubscribe = vi.fn(() => {
    if (unsubscribeDetaches) {
      listener = undefined;
    }
  });
  const signal: ContextSignal = {
    announce: (contextId) => {
      announced.push(contextId);
    },
    subscribe: (l) => {
      listener = l;
      return unsubscribe;
    },
  };
  return {
    signal,
    announced,
    unsubscribe,
    fire: (contextId: string) => listener?.(contextId),
  };
}

function transportFor(
  contexts: readonly AuthorizationContext[],
  decisions: readonly DecisionSet[] = [],
): { transport: AuthorizationTransport; permissionCalls: string[]; decisionCalls: number } {
  const permissionCalls: string[] = [];
  const counter = { decisionCalls: 0 };
  const transport: AuthorizationTransport = {
    listContexts: async () => contexts,
    fetchPermissions: async (_app, contextId) => {
      permissionCalls.push(contextId);
      return menu(contextId);
    },
    fetchDecisions: async (_app, contextId) => {
      counter.decisionCalls += 1;
      return (
        decisions[0] ?? {
          app: APP,
          contextId,
          decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" as const }],
        }
      );
    },
  };
  return {
    transport,
    permissionCalls,
    get decisionCalls() {
      return counter.decisionCalls;
    },
  } as { transport: AuthorizationTransport; permissionCalls: string[]; decisionCalls: number };
}

function session(over: Partial<AuthorizationSessionOptions> & { transport: AuthorizationTransport }) {
  return createAuthorizationSession({ app: APP, maxPairsPerRequest: 100, ...over });
}

const REQUEST = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1"] };

/* 1 — restoring ----------------------------------------------------------- */

describe("restoring the context at start()", () => {
  it("activates a stored id that is in the list, never showing the picker", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const m = memoryStore("c-2");
    const seen: string[] = [];
    const s = session({ transport: t.transport, contextStore: m.store });
    s.subscribe((st) => seen.push(st.status));

    await s.start();

    expect(seen).not.toContain("CHOOSING_CONTEXT");
    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-2" });
    expect(t.permissionCalls).toEqual(["c-2"]);
  });

  /** The security test. Red the moment the code trusts the store instead of the server's list. */
  it("IGNORES a stored id the server did not return, and clears it", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const m = memoryStore("c-ended");
    const s = session({ transport: t.transport, contextStore: m.store });

    await s.start();

    expect(s.getState().status).toBe("CHOOSING_CONTEXT");
    expect(m.clearSpy).toHaveBeenCalled();
    expect(m.read()).toBeNull();
    expect(t.permissionCalls).toEqual([]);
  });

  it("IGNORES a stored id whose context has no access, and clears it", async () => {
    // Not NO_ACCESS_IN_APP: that screen carries no context list, so it offers no way out.
    const t = transportFor([context("c-1"), context("c-2", false)]);
    const m = memoryStore("c-2");
    const s = session({ transport: t.transport, contextStore: m.store });

    await s.start();

    expect(s.getState().status).toBe("CHOOSING_CONTEXT");
    expect(m.clearSpy).toHaveBeenCalled();
    expect(t.permissionCalls).toEqual([]);
  });

  it("drops a read that a later start() superseded", async () => {
    // The read joins the generation protocol like every other awaited call. Without the check, a
    // slow store answering after a second start() would activate the context the first one read.
    const gate = deferred<string | null>();
    let reads = 0;
    const store: ContextStore = {
      read: () => {
        reads += 1;
        return reads === 1 ? gate.promise : "c-1";
      },
      write: () => {},
      clear: () => {},
    };
    const t = transportFor([context("c-1"), context("c-2")]);
    const s = session({ transport: t.transport, contextStore: store });

    const first = s.start();
    await settle();
    await s.start();
    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });

    gate.resolve("c-2");
    await first;
    await settle();

    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });
  });

  it("treats a read() that THROWS as nothing persisted", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const store: ContextStore = {
      read: () => {
        throw new Error("private window");
      },
      write: () => {},
      clear: () => {},
    };
    const s = session({ transport: t.transport, contextStore: store });

    await expect(s.start()).resolves.toBeUndefined();
    expect(s.getState().status).toBe("CHOOSING_CONTEXT");
  });

  it("treats a read() that REJECTS as nothing persisted", async () => {
    // Separate from the throwing case on purpose: a `try` that does not `await` catches one of
    // these two and not the other.
    const t = transportFor([context("c-1"), context("c-2")]);
    const store: ContextStore = {
      read: () => Promise.reject(new Error("quota")),
      write: () => {},
      clear: () => {},
    };
    const s = session({ transport: t.transport, contextStore: store });

    await expect(s.start()).resolves.toBeUndefined();
    expect(s.getState().status).toBe("CHOOSING_CONTEXT");
  });
});

/* 2 — the ports cannot take the session down --------------------------------- */

describe("neither port can take the session down", () => {
  it("reaches READY when write() throws", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const store: ContextStore = {
      read: () => null,
      write: () => {
        throw new Error("quota exceeded");
      },
      clear: () => {},
    };
    const s = session({ transport: t.transport, contextStore: store });
    await s.start();

    await s.selectContext("c-1");

    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });
  });

  it("reaches READY when announce() throws", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const signal: ContextSignal = {
      announce: () => {
        throw new Error("channel closed");
      },
      subscribe: () => () => {},
    };
    const s = session({ transport: t.transport, contextSignal: signal });
    await s.start();

    await s.selectContext("c-1");

    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });
  });
});

/* 3 — announcing ------------------------------------------------------------- */

describe("announcing", () => {
  it("announces exactly once, with the new id, on a real change", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();

    await s.selectContext("c-1");
    await s.selectContext("c-2");

    expect(g.announced).toEqual(["c-1", "c-2"]);
  });

  it("announces ZERO times when re-selecting the already-active context", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");
    g.announced.length = 0;

    await s.selectContext("c-1");

    expect(g.announced).toEqual([]);
  });

  it("announces ZERO times on the restore path and on the single-context auto-activation", async () => {
    const restored = transportFor([context("c-1"), context("c-2")]);
    const gRestore = driverSignal();
    const sRestore = session({
      transport: restored.transport,
      contextStore: memoryStore("c-2").store,
      contextSignal: gRestore.signal,
    });
    await sRestore.start();
    expect(gRestore.announced).toEqual([]);

    const single = transportFor([context("only")]);
    const gSingle = driverSignal();
    const sSingle = session({ transport: single.transport, contextSignal: gSingle.signal });
    await sSingle.start();
    expect(gSingle.announced).toEqual([]);
  });
});

/* 4 — receiving a notice ----------------------------------------------------- */

describe("receiving a notice from another tab", () => {
  it("does nothing at all when the notice carries the ACTIVE id", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");
    const before = s.getState();
    const emissions: unknown[] = [];
    s.subscribe((st) => emissions.push(st));

    g.fire("c-1");

    expect(emissions).toEqual([]);
    expect(s.getState()).toBe(before);
  });

  it("moves to CONTEXT_CHANGED_ELSEWHERE with both ids on a different id", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");

    g.fire("c-2");

    expect(s.getState()).toEqual({
      status: "CONTEXT_CHANGED_ELSEWHERE",
      contextId: "c-2",
      previousContextId: "c-1",
    });
  });

  /** The second security test. Red the moment the cache is not cleared in the same step. */
  it("stops answering: a pair that was PERMIT from cache now returns []", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");

    const before = await s.decide(REQUEST);
    expect(decisionFor(before, "read", "r-1")).toBe("PERMIT");

    g.fire("c-2");

    const after = await s.decide(REQUEST);
    expect(after).toEqual([]);
    expect(decisionFor(after, "read", "r-1")).toBe("DENY");
  });

  it("drops a decide() that was already in flight, and caches nothing from it", async () => {
    const gate = deferred<DecisionSet>();
    let calls = 0;
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_a, contextId) => menu(contextId),
      fetchDecisions: async () => {
        calls += 1;
        return calls === 1
          ? gate.promise
          : {
              app: APP,
              contextId: "c-1",
              decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" as const }],
            };
      },
    };
    const g = driverSignal();
    const s = session({ transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");

    const inFlight = s.decide(REQUEST);
    await settle();
    g.fire("c-2");
    gate.resolve({
      app: APP,
      contextId: "c-1",
      decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" as const }],
    });

    expect(await inFlight).toEqual([]);

    // Nothing was cached, so an identical question asks the transport again rather than
    // answering from the previous context's answers.
    await s.selectContext("c-1");
    await s.decide(REQUEST);
    expect(calls).toBe(2);
  });

  it("does not let a selectContext() already in flight land on READY", async () => {
    const gate = deferred<PermissionMenu>();
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_a, contextId) =>
        contextId === "c-1" ? gate.promise : menu(contextId),
      fetchDecisions: async () => ({ app: APP, contextId: "c-1", decisions: [] }),
    };
    const g = driverSignal();
    const s = session({ transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-2");

    const inFlight = s.selectContext("c-1");
    await settle();
    g.fire("c-3");
    gate.resolve(menu("c-1"));
    await inFlight;
    await settle();

    expect(s.getState().status).not.toBe("READY");
    expect(s.getState().status).toBe("CONTEXT_CHANGED_ELSEWHERE");
  });

  it("leaves an IDLE session IDLE and emits nothing", async () => {
    const t = transportFor([context("c-1")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    const emissions: unknown[] = [];
    s.subscribe((st) => emissions.push(st));

    g.fire("c-2");

    expect(s.getState()).toEqual({ status: "IDLE" });
    expect(emissions).toEqual([]);
  });

  /**
   * DEVIATION, pinned. The prompt says a notice that is neither an echo nor arriving while IDLE
   * moves the session to the new state. A session in CHOOSING_CONTEXT has no active context, so
   * `previousContextId` — typed `string` — could not be filled, and replacing a usable picker with
   * a banner would take away the only way forward while answering nothing: `decide()` already
   * returns `[]` there. It is treated like IDLE. See the report.
   */
  it("leaves a session with no active context alone (CHOOSING_CONTEXT)", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    const before = s.getState();
    expect(before.status).toBe("CHOOSING_CONTEXT");

    g.fire("c-2");

    expect(s.getState()).toBe(before);
  });
});

/* 5 — leaving the state, and teardown ---------------------------------------- */

describe("leaving CONTEXT_CHANGED_ELSEWHERE", () => {
  it("start() restores the new context from the store and reaches READY", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const m = memoryStore(null);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextStore: m.store, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");
    // The other tab wrote its selection into the shared store before announcing.
    m.store.write("c-2");
    g.fire("c-2");
    expect(s.getState().status).toBe("CONTEXT_CHANGED_ELSEWHERE");

    await s.start();

    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-2" });
  });

  it("selectContext(newId) reaches READY", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");
    g.fire("c-2");

    await s.selectContext("c-2");

    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-2" });
  });
});

describe("close()", () => {
  it("calls the signal's unsubscribe, and is idempotent", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");

    s.close();

    expect(g.unsubscribe).toHaveBeenCalledTimes(1);
    expect(() => {
      s.close();
    }).not.toThrow();
  });

  it("goes inert on its OWN: a notice after close() changes nothing even if the port keeps calling", async () => {
    // The signal here does not detach on unsubscribe, so the only thing that can stop the notice
    // is the session itself.
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal({ unsubscribeDetaches: false });
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");
    s.close();
    const before = s.getState();

    g.fire("c-2");

    expect(s.getState()).toBe(before);
  });

  it("emits ONE final IDLE and then drops every listener", async () => {
    // Order is the point: emit, THEN drop. Dropping first would mean nobody hears the transition
    // and the previous subject's menu would stay painted.
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    const emissions: unknown[] = [];
    s.subscribe((st) => emissions.push(st));

    s.close();
    expect(emissions).toEqual([{ status: "IDLE" }]);

    // Nothing after: the listener is gone, and start() is inert anyway.
    await s.start();
    expect(emissions).toEqual([{ status: "IDLE" }]);
  });
});

/* 6 — the ports are independent ---------------------------------------------- */

describe("the two ports are independent", () => {
  it("works with ONLY the signal: a notice still moves the session", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");

    g.fire("c-2");

    expect(s.getState()).toMatchObject({
      status: "CONTEXT_CHANGED_ELSEWHERE",
      previousContextId: "c-1",
    });
  });

  it("works with ONLY the store: restoration happens and selectContext completes", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const m = memoryStore("c-2");
    const s = session({ transport: t.transport, contextStore: m.store });

    await s.start();
    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-2" });

    await s.selectContext("c-1");
    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });
    expect(m.read()).toBe("c-1");
  });
});

/* 7 — start()'s own generation check ------------------------------------------ */

/**
 * These live in a file about the context ports for one reason, and it is the finding that put them
 * here: the generation check `start()` runs after `listContexts()` used to be pinned by a test in
 * `session.test.ts`, and the SECOND generation check this package added after `readStored()`
 * absorbed that scenario. Removing the first line now ships green. These two exercise the paths
 * that `return` before the newer check is ever reached.
 *
 * `session.test.ts` stays frozen, so they go here.
 */
describe("start() drops a superseded list", () => {
  it("does not repaint NO_CONTEXTS over a settled state", async () => {
    const gate = deferred<readonly AuthorizationContext[]>();
    let lists = 0;
    const transport: AuthorizationTransport = {
      listContexts: async () => {
        lists += 1;
        return lists === 1 ? gate.promise : [context("c-1")];
      },
      fetchPermissions: async (_a, contextId) => menu(contextId),
      fetchDecisions: async () => ({ app: APP, contextId: "c-1", decisions: [] }),
    };
    const s = session({ transport });

    const first = s.start();
    await settle();
    await s.start();
    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });

    gate.resolve([]);
    await first;
    await settle();

    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });
  });

  it("does not auto-activate the single context a superseded call returned", async () => {
    const gate = deferred<readonly AuthorizationContext[]>();
    let lists = 0;
    const transport: AuthorizationTransport = {
      listContexts: async () => {
        lists += 1;
        return lists === 1 ? gate.promise : [context("c-1"), context("c-2")];
      },
      fetchPermissions: async (_a, contextId) => menu(contextId),
      fetchDecisions: async () => ({ app: APP, contextId: "c-1", decisions: [] }),
    };
    const s = session({ transport });

    const first = s.start();
    await settle();
    await s.start();
    expect(s.getState().status).toBe("CHOOSING_CONTEXT");

    gate.resolve([context("c-a")]);
    await first;
    await settle();

    // BOTH halves. Asserting only the status would miss WHICH context won: with the guard gone,
    // `activate` runs, bumps the generation and takes ownership, and the session ends up READY
    // under a context a superseded call chose.
    expect(s.getState().status).toBe("CHOOSING_CONTEXT");
    const answers = await s.decide(REQUEST);
    expect(answers).toEqual([]);
  });
});

/* 8 — the last three port failures, and one more generation check ------------- */

describe("the remaining port failures cannot take the session down", () => {
  it("start() resolves when clear() throws, instead of stranding the session in LOADING", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const store: ContextStore = {
      read: () => "c-gone",
      write: () => {},
      clear: () => {
        throw new Error("private window");
      },
    };
    const s = session({ transport: t.transport, contextStore: store });

    await expect(s.start()).resolves.toBeUndefined();
    expect(s.getState().status).toBe("CHOOSING_CONTEXT");
  });

  it("the session can still be CONSTRUCTED when subscribe() throws", () => {
    const t = transportFor([context("c-1")]);
    const signal: ContextSignal = {
      announce: () => {},
      subscribe: () => {
        throw new Error("channel already discarded");
      },
    };

    expect(() => session({ transport: t.transport, contextSignal: signal })).not.toThrow();
  });

  it("close() does not throw when unsubscribe() throws, and still drops the listeners", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const signal: ContextSignal = {
      announce: () => {},
      subscribe: () => () => {
        throw new Error("channel already discarded");
      },
    };
    const s = session({ transport: t.transport, contextSignal: signal });
    await s.start();
    const emissions: unknown[] = [];
    s.subscribe((st) => emissions.push(st));

    expect(() => {
      s.close();
    }).not.toThrow();

    // One final IDLE and nothing more: the listeners were dropped even though unsubscribe threw.
    expect(emissions).toEqual([{ status: "IDLE" }]);
  });

  it("a start() parked inside an ASYNC clear() does not repaint over a later READY", async () => {
    // The port explicitly permits an async clear(), and that is what makes this reachable.
    const gate = deferred<void>();
    const store: ContextStore = {
      read: () => "c-gone",
      write: () => {},
      clear: () => gate.promise,
    };
    const t = transportFor([context("c-1"), context("c-2")]);
    const s = session({ transport: t.transport, contextStore: store });

    const parked = s.start();
    await settle();
    await s.selectContext("c-1");
    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });

    gate.resolve();
    await parked;
    await settle();

    expect(s.getState()).toMatchObject({ status: "READY", contextId: "c-1" });
  });
});

/* 9 — persistence happens only on the path that can be restored ---------------- */

describe("a context is stored only once the session reached READY under it", () => {
  function storeWith(initial: string | null) {
    let value = initial;
    const store: ContextStore = {
      read: () => value,
      write: (id) => {
        value = id;
      },
      clear: () => {
        value = null;
      },
    };
    return { store, read: () => value };
  }

  it("writes nothing when the selected context has no access, and leaves the previous value", async () => {
    const t = transportFor([context("c-1"), context("c-2", false)]);
    const m = storeWith("c-1");
    const s = session({ transport: t.transport, contextStore: m.store });
    await s.start();

    await s.selectContext("c-2");

    expect(s.getState().status).toBe("NO_ACCESS_IN_APP");
    expect(m.read()).toBe("c-1");
  });

  /** The trap the move exists to close: assert the RELOAD, not just the write. */
  it("writes nothing when the menu fetch rejects, so a reload is not restored into UNAVAILABLE", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_a, contextId) => {
        if (contextId === "c-2") {
          throw new Error("decision point down");
        }
        return menu(contextId);
      },
      fetchDecisions: async () => ({ app: APP, contextId: "c-1", decisions: [] }),
    };
    const m = storeWith(null);
    const first = session({ transport, contextStore: m.store });
    await first.start();
    await first.selectContext("c-2");
    expect(first.getState().status).toBe("UNAVAILABLE");
    expect(m.read()).toBeNull();

    // The reload: a fresh session against the same store must NOT land back in UNAVAILABLE.
    const second = session({ transport, contextStore: m.store });
    await second.start();

    expect(second.getState().status).toBe("CHOOSING_CONTEXT");
  });

  it("writes nothing when the menu comes back labelled with another context", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async () => menu("someone-else"),
      fetchDecisions: async () => ({ app: APP, contextId: "c-1", decisions: [] }),
    };
    const m = storeWith("c-1");
    const s = session({ transport, contextStore: m.store });
    await s.start();

    await s.selectContext("c-2");

    expect(s.getState().status).toBe("UNAVAILABLE");
    expect(m.read()).toBe("c-1");
  });

  it("still writes on the success path and on the restore path", async () => {
    const t = transportFor([context("c-1"), context("c-2")]);
    const m = storeWith(null);
    const s = session({ transport: t.transport, contextStore: m.store });
    await s.start();

    await s.selectContext("c-2");
    expect(m.read()).toBe("c-2");

    const restored = session({ transport: t.transport, contextStore: m.store });
    await restored.start();
    expect(restored.getState()).toMatchObject({ status: "READY", contextId: "c-2" });
    expect(m.read()).toBe("c-2");
  });

  it("a SUPERSEDED activate writes nothing", async () => {
    const gate = deferred<PermissionMenu>();
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_a, contextId) =>
        contextId === "c-2" ? gate.promise : menu(contextId),
      fetchDecisions: async () => ({ app: APP, contextId: "c-1", decisions: [] }),
    };
    const m = storeWith(null);
    const s = session({ transport, contextStore: m.store });
    await s.start();

    const superseded = s.selectContext("c-2");
    await settle();
    await s.selectContext("c-1");
    gate.resolve(menu("c-2"));
    await superseded;
    await settle();

    // c-1 won; the context the superseded call chose was never written.
    expect(m.read()).toBe("c-1");
  });

  it("a write() that never settles does not park the picker before LOADING", async () => {
    const never = new Promise<void>(() => {});
    const store: ContextStore = { read: () => null, write: () => never, clear: () => {} };
    const t = transportFor([context("c-1"), context("c-2")]);
    const s = session({ transport: t.transport, contextStore: store });
    await s.start();

    void s.selectContext("c-1");
    await settle();

    // The state moved and the menu was fetched BEFORE the write was awaited.
    expect(s.getState().status).not.toBe("CHOOSING_CONTEXT");
    expect(t.permissionCalls).toEqual(["c-1"]);
  });
});

/* 10 — the announce on the no-access path -------------------------------------- */

describe("announcing on the no-access path", () => {
  it("announces when the selected context has no access", async () => {
    // Correct and deliberate: the subject switched, the backend reads the active context from the
    // same shared place, and other tabs that kept answering would be painting permits it refuses.
    const t = transportFor([context("c-1"), context("c-2", false)]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");
    g.announced.length = 0;

    await s.selectContext("c-2");

    expect(s.getState().status).toBe("NO_ACCESS_IN_APP");
    expect(g.announced).toEqual(["c-2"]);
  });
});

/* 11 — a closed session is inert ------------------------------------------------ */

describe("a closed session answers nothing", () => {
  async function readySession() {
    const t = transportFor([context("c-1"), context("c-2")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("c-1");
    return { s, t, g };
  }

  it("returns [] for a pair that answered PERMIT from cache one call earlier", async () => {
    const { s } = await readySession();
    const before = await s.decide(REQUEST);
    expect(decisionFor(before, "read", "r-1")).toBe("PERMIT");

    s.close();

    const after = await s.decide(REQUEST);
    expect(after).toEqual([]);
    expect(decisionFor(after, "read", "r-1")).toBe("DENY");
  });

  it("lands on IDLE", async () => {
    const { s } = await readySession();

    s.close();

    expect(s.getState()).toEqual({ status: "IDLE" });
  });

  it("start() calls the transport zero times and leaves IDLE", async () => {
    const { s, t } = await readySession();
    s.close();
    const before = t.permissionCalls.length;

    await s.start();

    expect(t.permissionCalls.length).toBe(before);
    expect(s.getState()).toEqual({ status: "IDLE" });
  });

  it("selectContext() is inert and does not throw, not even RangeError", async () => {
    const { s, t } = await readySession();
    s.close();
    const before = t.permissionCalls.length;

    await expect(s.selectContext("c-2")).resolves.toBeUndefined();
    await expect(s.selectContext("no-such-context")).resolves.toBeUndefined();

    expect(t.permissionCalls.length).toBe(before);
    expect(s.getState()).toEqual({ status: "IDLE" });
  });

  it("subscribe() after close() registers nothing and its unsubscribe is safe", async () => {
    const { s } = await readySession();
    s.close();
    const emissions: unknown[] = [];

    const off = s.subscribe((st) => emissions.push(st));
    await s.start();

    expect(emissions).toEqual([]);
    expect(() => {
      off();
    }).not.toThrow();
  });

  it("a decide() already in flight contributes nothing and caches nothing", async () => {
    const gate = deferred<DecisionSet>();
    let calls = 0;
    const answer = {
      app: APP,
      contextId: "c-1",
      decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" as const }],
    };
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_a, contextId) => menu(contextId),
      fetchDecisions: async () => {
        calls += 1;
        return calls === 1 ? gate.promise : answer;
      },
    };
    const s = session({ transport });
    await s.start();
    await s.selectContext("c-1");

    const inFlight = s.decide(REQUEST);
    await settle();
    s.close();
    gate.resolve(answer);

    expect(await inFlight).toEqual([]);

    // A fresh session against the same transport hits it again: nothing was cached.
    const fresh = session({ transport });
    await fresh.start();
    await fresh.selectContext("c-1");
    await fresh.decide(REQUEST);
    expect(calls).toBe(2);
  });

  it("close() twice does not throw and emits only once", async () => {
    const { s } = await readySession();
    const emissions: unknown[] = [];
    s.subscribe((st) => emissions.push(st));

    s.close();
    expect(() => {
      s.close();
    }).not.toThrow();

    expect(emissions).toEqual([{ status: "IDLE" }]);
  });
});

/* 12 — the write is a suspension point like any other -------------------------- */

describe("a supersedable await is followed by a re-check", () => {
  /**
   * A store whose `write()` for one id parks until the test resolves it.
   *
   * The port explicitly admits an asynchronous store — `write` returns `Promise<void> | void` —
   * so this is in contract and not a contrived shape.
   */
  function parkingStore(parkFor: string) {
    const gate = deferred<void>();
    const store: ContextStore = {
      read: () => null,
      write: (contextId) => (contextId === parkFor ? gate.promise : undefined),
      clear: () => {},
    };
    return { store, release: () => gate.resolve() };
  }

  it("close() during the parked write leaves the session IDLE and never publishes READY", async () => {
    const p = parkingStore("ctx-b");
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const g = driverSignal();
    const s = session({
      transport: t.transport,
      contextStore: p.store,
      contextSignal: g.signal,
    });
    await s.start();
    await s.selectContext("ctx-a");

    // EVERY emission, not only the final state: a READY that is overwritten a microtask later
    // has still reached a subscriber's render function.
    const emissions: AuthorizationState[] = [];
    s.subscribe((state) => emissions.push(state));

    const parked = s.selectContext("ctx-b");
    await settle();
    expect(s.getState().status).toBe("LOADING");

    s.close();
    p.release();
    await parked;
    await settle();

    expect(s.getState()).toEqual({ status: "IDLE" });
    expect(emissions.map((e) => e.status)).toEqual(["LOADING", "IDLE"]);
    expect(emissions.some((e) => e.status === "READY")).toBe(false);
  });

  it("a close() during the parked write announces nothing", async () => {
    // Was `🔴 STILL ANNOUNCES after close()`, a test that PINNED THE DEFECT and whose own comment
    // instructed: "when it is closed this test goes red; delete it and write toEqual([])".
    // authz-003d closed it with the generation re-check in `selectContext`, this went red, and
    // here is the real assertion in its place.
    //
    // Note what the re-check is NOT: it is not a `closed` check. This case would fall to one, but
    // the sibling below — a live session superseded by a notice — would not, and that is the half
    // that evicts a tab which legitimately won.
    const p = parkingStore("ctx-b");
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const g = driverSignal();
    const s = session({
      transport: t.transport,
      contextStore: p.store,
      contextSignal: g.signal,
    });
    await s.start();
    await s.selectContext("ctx-a");
    g.announced.length = 0;

    const parked = s.selectContext("ctx-b");
    await settle();
    s.close();
    p.release();
    await parked;
    await settle();

    expect(g.announced).toEqual([]);
  });

  it("a notice during the parked write leaves CONTEXT_CHANGED_ELSEWHERE, with subscribers watching", async () => {
    const p = parkingStore("ctx-b");
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const g = driverSignal();
    const s = session({
      transport: t.transport,
      contextStore: p.store,
      contextSignal: g.signal,
    });
    await s.start();
    await s.selectContext("ctx-a");

    const emissions: AuthorizationState[] = [];
    s.subscribe((state) => emissions.push(state));

    const parked = s.selectContext("ctx-b");
    await settle();
    expect(s.getState().status).toBe("LOADING");

    // This path never dropped the listeners, so a stray READY reaches a render function.
    g.fire("ctx-c");
    p.release();
    await parked;
    await settle();

    expect(s.getState()).toEqual({
      status: "CONTEXT_CHANGED_ELSEWHERE",
      contextId: "ctx-c",
      previousContextId: "ctx-b",
    });
    expect(emissions.map((e) => e.status)).toEqual(["LOADING", "CONTEXT_CHANGED_ELSEWHERE"]);
  });

  it("does not reach READY while the write is still in flight", async () => {
    // Pins the `await` on writeStored, which no test reached before. A floating
    // `void writeStored(...)` never suspends, so it would run setState unconditionally and
    // paint READY over a write that has not happened.
    const never = new Promise<void>(() => {});
    const store: ContextStore = { read: () => null, write: () => never, clear: () => {} };
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const s = session({ transport: t.transport, contextStore: store });
    await s.start();

    void s.selectContext("ctx-a");
    await settle();

    expect(t.permissionCalls).toEqual(["ctx-a"]);
    expect(s.getState().status).toBe("LOADING");
  });
});

/* 13 — a listener that throws is contained ------------------------------------- */

describe("a subscribed listener cannot take the session down", () => {
  function thrower() {
    return () => {
      throw new Error("a consumer render bug");
    };
  }

  it("does not deny the notification to a listener subscribed after it", async () => {
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const s = session({ transport: t.transport });
    const seen: string[] = [];
    s.subscribe(thrower());
    s.subscribe((state) => {
      seen.push(state.status);
    });

    await s.start();
    await s.selectContext("ctx-a");

    expect(seen).toEqual(["LOADING", "CHOOSING_CONTEXT", "LOADING", "READY"]);
  });

  it("does not break close(): the listeners are dropped, the signal is unsubscribed, the session is inert", async () => {
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    // An unsubscribe that does NOT detach is the only way to prove the session goes inert on
    // its own rather than relying on the port to stop calling it.
    const g = driverSignal({ unsubscribeDetaches: false });
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("ctx-a");

    const seen: string[] = [];
    s.subscribe(thrower());
    s.subscribe((state) => {
      seen.push(state.status);
    });

    expect(() => {
      s.close();
    }).not.toThrow();

    expect(seen).toEqual(["IDLE"]);
    expect(g.unsubscribe).toHaveBeenCalledTimes(1);

    g.fire("ctx-b");
    expect(s.getState()).toEqual({ status: "IDLE" });
    expect(seen).toEqual(["IDLE"]);
  });

  it("close() after a thrower is still idempotent", async () => {
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const s = session({ transport: t.transport });
    await s.start();
    await s.selectContext("ctx-a");
    s.subscribe(thrower());

    s.close();
    expect(() => {
      s.close();
    }).not.toThrow();
    expect(s.getState()).toEqual({ status: "IDLE" });
  });

  it("does not break start(): the call resolves and the session still reaches its state", async () => {
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const s = session({ transport: t.transport });
    s.subscribe(thrower());

    await expect(s.start()).resolves.toBeUndefined();
    expect(s.getState()).toMatchObject({ status: "CHOOSING_CONTEXT" });
  });
});

/* 14 — CONTEXT_CHANGED_ELSEWHERE is delivered, not only stored ------------------ */

describe("the CONTEXT_CHANGED_ELSEWHERE emission", () => {
  it("reaches a subscriber, carrying both ids", async () => {
    // Every other test for this state reads getState(). The state being right and the
    // notification being delivered are two different promises, and this pins the second.
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("ctx-a");

    const emissions: AuthorizationState[] = [];
    s.subscribe((state) => emissions.push(state));

    g.fire("ctx-b");

    expect(emissions).toEqual([
      { status: "CONTEXT_CHANGED_ELSEWHERE", contextId: "ctx-b", previousContextId: "ctx-a" },
    ]);
  });
});

/* 9 — close() is final, and a superseded selection does not speak ---------- */

describe("close() is final: the flag is set before the last emission", () => {
  it("a listener that calls start() from the final IDLE leaves the session IDLE", async () => {
    // MAJOR-A, measured on the shipped code: `closed` was set AFTER this emission, so during it
    // the session still answered. A listener re-entering `start()` was served — and served
    // correctly, because `close()` bumps the generation before the emission and nothing bumps it
    // after, so the re-entrant call's own bump made it the newest generation. The closed session
    // came back READY with a permission menu and `decide()` answered PERMIT.
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const s = session({ transport: t.transport });
    await s.start();
    await s.selectContext("ctx-a");

    const callsBeforeClose = t.permissionCalls.length;
    let reentered: Promise<void> | undefined;
    s.subscribe((st) => {
      if (st.status === "IDLE" && reentered === undefined) {
        reentered = s.start();
      }
    });

    s.close();
    await reentered;
    await settle();

    expect(s.getState()).toEqual({ status: "IDLE" });
    expect(t.permissionCalls.length).toBe(callsBeforeClose);
    expect(await s.decide(REQUEST)).toEqual([]);
  });

  it("a listener that calls selectContext() from the final IDLE leaves the session IDLE", async () => {
    // The context LIST is never cleared by `close()`, so "ctx-b" resolves and no RangeError masks
    // the defect — which is what makes this the honest second half of the case.
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const s = session({ transport: t.transport });
    await s.start();
    await s.selectContext("ctx-a");

    const callsBeforeClose = t.permissionCalls.length;
    let reentered: Promise<void> | undefined;
    s.subscribe((st) => {
      if (st.status === "IDLE" && reentered === undefined) {
        reentered = s.selectContext("ctx-b");
      }
    });

    s.close();
    await reentered;
    await settle();

    expect(s.getState()).toEqual({ status: "IDLE" });
    expect(t.permissionCalls.length).toBe(callsBeforeClose);
    expect(await s.decide(REQUEST)).toEqual([]);
  });

  it("a listener subscribed after close() receives nothing, on a session someone resurrected", async () => {
    // MINOR-3: `subscribe`'s `closed` branch was declared unobservable. It IS observable, but only
    // through the door MAJOR-A opened, and reproducing it took two tries — the first version of
    // this test called `start()` from OUTSIDE the emission, where `start()`'s own `closed` guard
    // already returns, so it stayed green with the branch removed and proved nothing.
    //
    // The real shape: one listener re-enters `start()` FROM the final IDLE emission — that is the
    // resurrection — and a second listener subscribes afterwards. Without the branch, that second
    // listener receives the resurrected session's ["LOADING","READY"]: a live menu delivered to a
    // subscriber of a closed session.
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const s = session({ transport: t.transport });
    await s.start();
    await s.selectContext("ctx-a");

    let resurrection: Promise<void> | undefined;
    s.subscribe((st) => {
      if (st.status === "IDLE" && resurrection === undefined) {
        resurrection = s.start();
      }
    });

    s.close();

    const late: string[] = [];
    const off = s.subscribe((st) => late.push(st.status));

    await resurrection;
    await settle();

    expect(late).toEqual([]);
    expect(s.getState()).toEqual({ status: "IDLE" });
    expect(() => off()).not.toThrow();
  });
});

describe("a superseded selection does not announce", () => {
  function parkingStore(parkFor: string) {
    const gate = deferred<void>();
    const store: ContextStore = {
      read: () => null,
      write: (contextId) => (contextId === parkFor ? gate.promise : undefined),
      clear: () => {},
    };
    return { store, release: () => gate.resolve() };
  }

  it("a notice during the parked write announces nothing — no close() anywhere", async () => {
    // MAJOR-B, and the half a `closed` check would NOT have caught: the session is LIVE. It ends
    // on CONTEXT_CHANGED_ELSEWHERE for ctx-c and, before the fix, announced ctx-b — a context it
    // never reached READY under.
    const p = parkingStore("ctx-b");
    const t = transportFor([context("ctx-a"), context("ctx-b"), context("ctx-c")]);
    const g = driverSignal();
    const s = session({
      transport: t.transport,
      contextStore: p.store,
      contextSignal: g.signal,
    });
    await s.start();
    await s.selectContext("ctx-a");
    g.announced.length = 0;

    const parked = s.selectContext("ctx-b");
    await settle();
    g.fire("ctx-c");
    p.release();
    await parked;
    await settle();

    expect(g.announced).toEqual([]);
    expect(s.getState()).toEqual({
      status: "CONTEXT_CHANGED_ELSEWHERE",
      contextId: "ctx-c",
      // MEASURED, and worth knowing: "ctx-b" and not "ctx-a". `activate` sets `activeContextId`
      // on entry, so by the time the notice lands the session already calls ctx-b its previous
      // context — one it never reached READY under. Pre-existing behaviour; pinned, not changed.
      previousContextId: "ctx-b",
    });
  });

  it("the superseded tab does not evict the tab that legitimately won", async () => {
    // THE TEST THAT PINS THE DAMAGE RATHER THAN THE MECHANISM. Two sessions on one channel:
    // A parks in its store write; B legitimately selects ctx-c and announces; A is correctly
    // evicted. Then A's parked write releases and — before the fix — A announced ctx-b, knocking
    // B out of a context it had just correctly selected, leaving a banner naming a context NO TAB
    // IS IN.
    const contexts = [context("ctx-a"), context("ctx-b"), context("ctx-c")];
    const listeners: ((contextId: string) => void)[] = [];
    const announced: string[] = [];
    const sharedSignal = (): ContextSignal => ({
      announce: (contextId) => {
        announced.push(contextId);
        // A real channel delivers to the OTHER tabs.
        for (const l of [...listeners]) l(contextId);
      },
      subscribe: (l) => {
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    });

    const gate = deferred<void>();
    const parkingA: ContextStore = {
      read: () => null,
      write: (contextId) => (contextId === "ctx-b" ? gate.promise : undefined),
      clear: () => {},
    };

    const tA = transportFor(contexts);
    const signalA = sharedSignal();
    const a = session({ transport: tA.transport, contextStore: parkingA, contextSignal: signalA });
    const tB = transportFor(contexts);
    const signalB = sharedSignal();
    const b = session({ transport: tB.transport, contextSignal: signalB });

    await a.start();
    await b.start();
    await a.selectContext("ctx-a");
    await b.selectContext("ctx-a");
    announced.length = 0;

    // A parks mid-write on ctx-b.
    const parkedA = a.selectContext("ctx-b");
    await settle();

    // B legitimately selects ctx-c and announces. A hears it and is correctly evicted.
    await b.selectContext("ctx-c");
    await settle();
    expect(a.getState()).toEqual({
      status: "CONTEXT_CHANGED_ELSEWHERE",
      contextId: "ctx-c",
      // MEASURED, and worth knowing: "ctx-b" and not "ctx-a". `activate` sets `activeContextId`
      // on entry, so by the time the notice lands the session already calls ctx-b its previous
      // context — one it never reached READY under. Pre-existing behaviour; pinned, not changed.
      previousContextId: "ctx-b",
    });
    expect(b.getState()).toMatchObject({ status: "READY", contextId: "ctx-c" });

    // A's write releases. A is superseded, so it must not speak.
    gate.resolve();
    await parkedA;
    await settle();

    expect(announced).toEqual(["ctx-c"]);
    expect(b.getState()).toMatchObject({ status: "READY", contextId: "ctx-c" });
  });

  it("a selection that ends in no-access still announces", async () => {
    // GUARD AGAINST OVER-FIXING. The predicate is "was I superseded", not "did I reach READY":
    // the subject DID switch, and a tab that kept answering would be painting permits the backend
    // will refuse.
    const t = transportFor([context("ctx-a"), context("ctx-b", false)]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("ctx-a");
    g.announced.length = 0;

    await s.selectContext("ctx-b");
    await settle();

    expect(s.getState()).toEqual({ status: "NO_ACCESS_IN_APP", contextId: "ctx-b" });
    expect(g.announced).toEqual(["ctx-b"]);
  });

  it("a selection that ends in unavailable still announces", async () => {
    const t = transportFor([context("ctx-a"), context("ctx-b")]);
    const original = t.transport.fetchPermissions;
    t.transport.fetchPermissions = async (app, contextId) => {
      if (contextId === "ctx-b") throw new Error("the decision point is down");
      return original(app, contextId);
    };
    const g = driverSignal();
    const s = session({ transport: t.transport, contextSignal: g.signal });
    await s.start();
    await s.selectContext("ctx-a");
    g.announced.length = 0;

    await s.selectContext("ctx-b");
    await settle();

    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });
    expect(g.announced).toEqual(["ctx-b"]);
  });

  it("a selection superseded DURING the write does write — the narrow claim, pinned", async () => {
    // MINOR-2. Three places claimed a superseded selection writes NOTHING. Measured false: the
    // write completes before the re-check that follows it, so a selection superseded during the
    // WRITE does write. Not writing would require knowing a supersession that has not happened
    // yet, so the prose was narrowed instead and this pins the real behaviour.
    //
    // It is acceptable because the stored id is a HINT, re-validated against the server's list at
    // start(): a stale write can cost a re-selection, never an access.
    const gate = deferred<void>();
    let stored: string | null = null;
    const store: ContextStore = {
      read: () => stored,
      write: (contextId) => {
        stored = contextId;
        return contextId === "ctx-b" ? gate.promise : undefined;
      },
      clear: () => {
        stored = null;
      },
    };
    const t = transportFor([context("ctx-a"), context("ctx-b"), context("ctx-c")]);
    const g = driverSignal();
    const s = session({ transport: t.transport, contextStore: store, contextSignal: g.signal });
    await s.start();
    await s.selectContext("ctx-a");

    const parked = s.selectContext("ctx-b");
    await settle();
    g.fire("ctx-c");
    gate.resolve();
    await parked;
    await settle();

    // The superseded selection DID write. This is the measured behaviour, not the desired one.
    expect(stored).toBe("ctx-b");
    expect(s.getState()).toEqual({
      status: "CONTEXT_CHANGED_ELSEWHERE",
      contextId: "ctx-c",
      // MEASURED, and worth knowing: "ctx-b" and not "ctx-a". `activate` sets `activeContextId`
      // on entry, so by the time the notice lands the session already calls ctx-b its previous
      // context — one it never reached READY under. Pre-existing behaviour; pinned, not changed.
      previousContextId: "ctx-b",
    });
  });
});
