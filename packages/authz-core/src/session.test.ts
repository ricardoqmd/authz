import { describe, expect, it, vi } from "vitest";

import { decisionFor, isRenderable, type Decision } from "./decision.js";
import { createAuthorizationSession, type AuthorizationSession } from "./session.js";
import {
  AuthorizationTransportError,
  type AuthorizationContext,
  type AuthorizationTransport,
  type DecisionRequest,
  type DecisionSet,
  type PermissionMenu,
} from "./transport.js";

/**
 * The doubles are built here, inline, and nothing like them ships in `src`. A mock transport
 * that lived in the package would eventually be imported by a consumer "just for development"
 * and would answer `PERMIT` in production.
 */

const APP = "app-a";

function context(
  contextId: string,
  hasAccess = true,
  label = contextId,
): AuthorizationContext {
  return { contextId, label, hasAccess };
}

function menu(contextId: string, actions: readonly string[]): PermissionMenu {
  return {
    app: APP,
    contextId,
    permissions: actions.map((action) => ({ action, effect: "PERMIT" as const })),
  };
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

describe("createAuthorizationSession — contexts", () => {
  it("auto-selects when there is exactly one context and never shows a picker", async () => {
    const seen: string[] = [];
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    session.subscribe((s) => seen.push(s.status));
    await session.start();

    // The picker is never entered, not even for a tick.
    expect(seen).not.toContain("CHOOSING_CONTEXT");
    expect(session.getState()).toEqual({
      status: "READY",
      contextId: "c-1",
      permissions: [{ action: "read", effect: "PERMIT" }],
    });
  });

  it("offers the picker with two or more contexts", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();

    expect(session.getState().status).toBe("CHOOSING_CONTEXT");
  });

  it("reports NO_CONTEXTS when the subject holds none", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [],
      fetchPermissions: async (_app, contextId) => menu(contextId, []),
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();

    expect(session.getState().status).toBe("NO_CONTEXTS");
  });

  it("is UNAVAILABLE when listing the contexts rejects", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => {
        throw new AuthorizationTransportError("UNAVAILABLE", "decision point unreachable");
      },
      fetchPermissions: async (_app, contextId) => menu(contextId, []),
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();

    expect(session.getState().status).toBe("UNAVAILABLE");
  });

  it("rejects an unknown contextId with RangeError and leaves the state alone", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();
    const before = session.getState();

    await expect(session.selectContext("c-9")).rejects.toThrow(RangeError);
    expect(session.getState()).toBe(before);
  });

  /**
   * The mutation this catches: fetching the menu anyway and inferring "no access" from an
   * empty answer. That inference cannot tell "this context does not open this app" from
   * "it opens it and you may do nothing", which are different screens.
   */
  it("never asks for permissions when the context has no access to the app", async () => {
    const fetchPermissions = vi.fn(async (_app: string, contextId: string) =>
      menu(contextId, ["read"]),
    );
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2", false)],
      fetchPermissions,
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();
    await session.selectContext("c-2");

    expect(fetchPermissions).not.toHaveBeenCalled();
    expect(session.getState()).toEqual({
      status: "NO_ACCESS_IN_APP",
      contextId: "c-2",
    });
  });

  /**
   * The mutation this catches: falling into `READY` with `[]`. The status is asserted, not
   * just the emptiness of the menu — an empty `READY` reads to a consumer as a legitimate
   * "you may do nothing" and renders an empty screen instead of saying what happened.
   */
  it("is UNAVAILABLE when the permissions fetch rejects, never READY with an empty menu", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1")],
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("UNAVAILABLE", "timed out");
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();

    const state = session.getState();
    expect(state.status).toBe("UNAVAILABLE");
    expect(state.status).not.toBe("READY");
  });

  it("is NO_ACCESS_IN_APP when the permissions fetch rejects with that kind", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1")],
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("NO_ACCESS_IN_APP");
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();

    expect(session.getState()).toEqual({
      status: "NO_ACCESS_IN_APP",
      contextId: "c-1",
    });
  });

  /**
   * The mutation this catches: a cache keyed without the context, which would serve A's menu
   * for B. Both halves are asserted — that the transport was asked again, and that what the
   * state carries is B's.
   */
  it("does not serve the previous context's menu after a switch", async () => {
    const fetchPermissions = vi.fn(async (_app: string, contextId: string) =>
      menu(contextId, contextId === "c-1" ? ["read"] : ["approve"]),
    );
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions,
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();
    await session.selectContext("c-1");
    await session.selectContext("c-2");

    expect(fetchPermissions).toHaveBeenCalledTimes(2);
    expect(session.getState()).toEqual({
      status: "READY",
      contextId: "c-2",
      permissions: [{ action: "approve", effect: "PERMIT" }],
    });
  });

  it("goes through LOADING on a switch and never lingers on the previous READY", async () => {
    const second = deferred<PermissionMenu>();
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_app, contextId) =>
        contextId === "c-1" ? menu("c-1", ["read"]) : second.promise,
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();
    await session.selectContext("c-1");
    expect(session.getState().status).toBe("READY");

    const switching = session.selectContext("c-2");
    await settle();

    // While B is in flight the state is LOADING, not A's READY.
    expect(session.getState().status).toBe("LOADING");

    second.resolve(menu("c-2", ["approve"]));
    await switching;
    expect(session.getState().status).toBe("READY");
  });

  /**
   * The mutation this catches: the last promise to resolve winning. A's answer arrives after
   * the switch to B and must be dropped — not merged, not rendered.
   */
  it("drops a permissions answer that arrives after the context changed", async () => {
    const first = deferred<PermissionMenu>();
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_app, contextId) =>
        contextId === "c-1" ? first.promise : menu("c-2", ["approve"]),
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    };

    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 100,
    });
    await session.start();

    // A's fetch starts and stays in flight.
    const forA = session.selectContext("c-1");
    await settle();
    expect(session.getState().status).toBe("LOADING");

    // The subject switches to B, which settles.
    await session.selectContext("c-2");
    expect(session.getState()).toEqual({
      status: "READY",
      contextId: "c-2",
      permissions: [{ action: "approve", effect: "PERMIT" }],
    });

    // Only now does A answer. It belongs to a context the session already left.
    first.resolve(menu("c-1", ["read"]));
    await forA;
    await settle();

    expect(session.getState()).toEqual({
      status: "READY",
      contextId: "c-2",
      permissions: [{ action: "approve", effect: "PERMIT" }],
    });
  });
});

describe("createAuthorizationSession — decide", () => {
  function readySession(
    fetchDecisions: AuthorizationTransport["fetchDecisions"],
    maxPairsPerRequest: number,
  ) {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions,
    };
    return createAuthorizationSession({ app: APP, transport, maxPairsPerRequest });
  }

  /**
   * The mutation this catches: failing the whole batch when one chunk fails, and — worse —
   * treating the missing chunk as permitted. The successful chunk keeps its effects; the
   * failed one contributes nothing, so its pairs resolve to `DENY` through `decisionFor`.
   */
  it("denies only the pairs of the chunk that failed, and does not reject", async () => {
    const fetchDecisions = vi.fn(
      async (_app: string, _contextId: string, request: { resourceIds: readonly string[] }) => {
        if (request.resourceIds.includes("r-2")) {
          throw new AuthorizationTransportError("UNAVAILABLE", "chunk failed");
        }
        const set: DecisionSet = {
          app: APP,
          contextId: "c-1",
          decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" }],
        };
        return set;
      },
    );

    const session = readySession(fetchDecisions, 1);
    await session.start();

    const decisions = await session.decide({
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1", "r-2"],
    });

    expect(fetchDecisions).toHaveBeenCalledTimes(2);
    expect(decisionFor(decisions, "read", "r-1")).toBe("PERMIT");
    expect(decisionFor(decisions, "read", "r-2")).toBe("DENY");
  });

  it("asks one call per chunk and merges what came back", async () => {
    const fetchDecisions = vi.fn(
      async (_app: string, _contextId: string, request: { resourceIds: readonly string[] }) => {
        const set: DecisionSet = {
          app: APP,
          contextId: "c-1",
          decisions: request.resourceIds.map((resourceId) => ({
            action: "read",
            resourceId,
            effect: "PERMIT" as const,
          })),
        };
        return set;
      },
    );

    const session = readySession(fetchDecisions, 2);
    await session.start();

    const decisions = await session.decide({
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1", "r-2", "r-3", "r-4", "r-5"],
    });

    expect(fetchDecisions).toHaveBeenCalledTimes(3);
    expect(decisions).toHaveLength(5);
  });

  it("serves a fully cached request without asking again, and clears on a context switch", async () => {
    const fetchDecisions = vi.fn(async () => {
      const set: DecisionSet = {
        app: APP,
        contextId: "c-1",
        decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" }],
      };
      return set;
    });
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-1"), context("c-2")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions,
    };
    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 10,
    });
    await session.start();
    await session.selectContext("c-1");

    const request = {
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1"],
    };
    await session.decide(request);
    await session.decide(request);
    expect(fetchDecisions).toHaveBeenCalledTimes(1);

    // A different context must not read the previous one's answers.
    await session.selectContext("c-2");
    await session.decide(request);
    expect(fetchDecisions).toHaveBeenCalledTimes(2);
  });

  it("answers nothing when no context is active, so every pair denies", async () => {
    const session = readySession(async () => {
      throw new Error("not used");
    }, 10);

    const decisions = await session.decide({
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1"],
    });

    expect(decisions).toEqual([]);
    expect(decisionFor(decisions, "read", "r-1")).toBe("DENY");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * authz-001b — the FIX-FIRST round. Each block names the finding it closes.
 * ──────────────────────────────────────────────────────────────────────────── */

const ctxAB: readonly AuthorizationContext[] = [context("c-a"), context("c-b")];

/** A transport whose every call is controlled by the test. */
function riggedSession(over: Partial<AuthorizationTransport> = {}, maxPairs = 10) {
  const transport: AuthorizationTransport = {
    listContexts: async () => ctxAB,
    fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
    fetchDecisions: async (_app, contextId, request) => ({
      app: APP,
      contextId,
      decisions: request.resourceIds.map((resourceId) => ({
        action: request.actions[0] ?? "read",
        resourceId,
        effect: "PERMIT" as const,
      })),
    }),
    ...over,
  };
  return createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: maxPairs });
}

describe("MAJOR A — start() joins the generation protocol", () => {
  it("a second start() resolving late does not change state", async () => {
    const first = deferred<readonly AuthorizationContext[]>();
    const second = deferred<readonly AuthorizationContext[]>();
    let call = 0;
    const session = riggedSession({
      listContexts: async () => (++call === 1 ? first.promise : second.promise),
    });

    const a = session.start();
    const b = session.start();
    second.resolve([context("c-b")]);
    await b;
    await settle();
    const afterSecond = session.getState();

    first.resolve(ctxAB);
    await a;
    await settle();

    // The first call is superseded: it must not repaint the picker over c-b's READY.
    expect(session.getState()).toEqual(afterSecond);
    expect(session.getState().status).toBe("READY");
  });

  it("an activate in flight does not paint READY over a later start()'s picker", async () => {
    const perms = deferred<PermissionMenu>();
    const session = riggedSession({ fetchPermissions: async () => perms.promise });

    await session.start();
    await settle();
    expect(session.getState().status).toBe("CHOOSING_CONTEXT");

    const activating = session.selectContext("c-a");
    await settle();
    expect(session.getState().status).toBe("LOADING");

    await session.start();
    await settle();
    expect(session.getState().status).toBe("CHOOSING_CONTEXT");

    // The menu for c-a lands after the re-list. It belongs to a session state that is gone.
    perms.resolve(menu("c-a", ["read"]));
    await activating;
    await settle();

    expect(session.getState().status).toBe("CHOOSING_CONTEXT");
  });

  /**
   * The session must ALREADY be in a context with a warm cache when the second `start()`
   * begins — otherwise `activeContextId` was undefined all along and the test passes without
   * exercising the clearing at all. Measured: written the naive way, reverting the fix left
   * this green.
   */
  it("while a re-start is in flight, decide() returns [] and never calls the transport", async () => {
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) => ({
      app: APP,
      contextId,
      decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" as const }],
    }));
    const listing = deferred<readonly AuthorizationContext[]>();
    let call = 0;
    const session = riggedSession({
      listContexts: async () => (++call === 1 ? ctxAB : listing.promise),
      fetchDecisions,
    });

    // In a context, with that pair cached.
    await session.start();
    await session.selectContext("c-a");
    await session.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] });
    expect(fetchDecisions).toHaveBeenCalledTimes(1);

    // Re-listing: not in a context any more, and the cache is not an answer.
    const starting = session.start();
    await settle();
    fetchDecisions.mockClear();

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });

    expect(out).toEqual([]);
    expect(fetchDecisions).not.toHaveBeenCalled();

    listing.resolve(ctxAB);
    await starting;
  });
});

describe("MAJOR B — decide only accepts what it asked for", () => {
  it("drops a decision whose pair was not requested, and does not cache it", async () => {
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) => ({
      app: APP,
      contextId,
      decisions: [
        { action: "read", resourceId: "r-1", effect: "PERMIT" as const },
        // Never asked for. Returning it would answer a question nobody posed; caching it
        // would then serve that answer to the later genuine query.
        { action: "delete", resourceId: "r-1", effect: "PERMIT" as const },
      ],
    }));
    const session = riggedSession({ fetchDecisions });
    await session.start();
    await session.selectContext("c-a");

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });

    expect(out.map((d) => d.action)).toEqual(["read"]);
    expect(decisionFor(out, "delete", "r-1")).toBe("DENY");

    // And it was not cached: the genuine question for it reaches the transport.
    fetchDecisions.mockClear();
    await session.decide({ resourceType: "doc", actions: ["delete"], resourceIds: ["r-1"] });
    expect(fetchDecisions).toHaveBeenCalledTimes(1);
  });

  it("discards a whole response whose contextId is not the active one", async () => {
    const fetchDecisions = vi.fn(async () => ({
      app: APP,
      contextId: "c-somewhere-else",
      decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" as const }],
    }));
    const session = riggedSession({ fetchDecisions });
    await session.start();
    await session.selectContext("c-a");

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });

    expect(out).toEqual([]);
    fetchDecisions.mockClear();
    await session.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] });
    expect(fetchDecisions).toHaveBeenCalledTimes(1);
  });

  it("discards a whole response whose app is not this session's", async () => {
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) => ({
      app: "another-app",
      contextId,
      decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" as const }],
    }));
    const session = riggedSession({ fetchDecisions });
    await session.start();
    await session.selectContext("c-a");

    expect(
      await session.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] }),
    ).toEqual([]);
  });

  it("a menu labelled with another context lands on UNAVAILABLE, not READY", async () => {
    const session = riggedSession({
      fetchPermissions: async () => menu("c-somewhere-else", ["read"]),
    });
    await session.start();
    await session.selectContext("c-a");

    expect(session.getState().status).toBe("UNAVAILABLE");
  });
});

describe("MINOR C — decide honours NO_ACCESS_IN_APP", () => {
  it("returns [] without calling the transport", async () => {
    const fetchDecisions = vi.fn(async () => ({ app: APP, contextId: "c-a", decisions: [] }));
    const session = riggedSession({
      listContexts: async () => [context("c-a", false)],
      fetchDecisions,
    });
    await session.start();
    expect(session.getState().status).toBe("NO_ACCESS_IN_APP");

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });

    expect(out).toEqual([]);
    expect(fetchDecisions).not.toHaveBeenCalled();
  });
});

describe("MINOR D and E — the two guards that were never exercised", () => {
  it("D: a permissions REJECTION for A after a switch to B leaves B's READY alone", async () => {
    const a = deferred<PermissionMenu>();
    const session = riggedSession({
      fetchPermissions: async (_app, contextId) =>
        contextId === "c-a" ? a.promise : menu(contextId, ["read"]),
    });
    await session.start();

    const activatingA = session.selectContext("c-a");
    await settle();
    await session.selectContext("c-b");
    expect(session.getState().status).toBe("READY");

    a.reject(new AuthorizationTransportError("UNAVAILABLE", "late failure for A"));
    await activatingA;
    await settle();

    // Without the guard in the catch, this would be UNAVAILABLE.
    const s = session.getState();
    expect(s.status).toBe("READY");
    expect(s.status === "READY" && s.contextId).toBe("c-b");
  });

  it("E: decisions for A resolving after a switch to B are [] and are not cached for B", async () => {
    const a = deferred<{
      app: string;
      contextId: string;
      decisions: readonly { action: string; resourceId: string; effect: "PERMIT" }[];
    }>();
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) =>
      contextId === "c-a"
        ? a.promise
        : { app: APP, contextId, decisions: [] as never[] },
    );
    const session = riggedSession({ fetchDecisions });
    await session.start();
    await session.selectContext("c-a");

    const deciding = session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });
    await settle();
    await session.selectContext("c-b");

    a.resolve({
      app: APP,
      contextId: "c-a",
      decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" }],
    });
    expect(await deciding).toEqual([]);

    // Nothing was written for B: the same question reaches the transport again.
    fetchDecisions.mockClear();
    await session.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] });
    expect(fetchDecisions).toHaveBeenCalledTimes(1);
  });
});

describe("MINOR G — the decision cache is bounded", () => {
  it("evicts oldest-first, and an evicted pair is asked again", async () => {
    const fetchDecisions = vi.fn(async (_app: string, contextId: string, request: DecisionRequest) => ({
      app: APP,
      contextId,
      decisions: request.resourceIds.map((resourceId: string) => ({
        action: "read",
        resourceId,
        effect: "PERMIT" as const,
      })),
    }));
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-a")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions,
    };
    const session = createAuthorizationSession({
      app: APP,
      transport,
      maxPairsPerRequest: 10,
      maxCachedDecisions: 2,
    });
    await session.start();

    const ask = (id: string) =>
      session.decide({ resourceType: "doc", actions: ["read"], resourceIds: [id] });

    await ask("r-1");
    await ask("r-2");
    await ask("r-3"); // evicts r-1, the oldest

    fetchDecisions.mockClear();
    await ask("r-2"); // still cached
    expect(fetchDecisions).not.toHaveBeenCalled();

    await ask("r-1"); // evicted: has to be asked again
    expect(fetchDecisions).toHaveBeenCalledTimes(1);
  });

  it("rejects a bound below 1 at construction", () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [],
      fetchPermissions: async () => menu("c-a", []),
      fetchDecisions: async () => ({ app: APP, contextId: "c-a", decisions: [] }),
    };
    expect(() =>
      createAuthorizationSession({
        app: APP,
        transport,
        maxPairsPerRequest: 10,
        maxCachedDecisions: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("MINOR H and NOTE K — the state surface", () => {
  it("UNAVAILABLE carries no reason", async () => {
    const session = riggedSession({
      listContexts: async () => {
        throw new AuthorizationTransportError("UNAVAILABLE", "a secret from the server");
      },
    });
    await session.start();

    const s = session.getState();
    expect(s).toEqual({ status: "UNAVAILABLE" });
    expect(JSON.stringify(s)).not.toContain("a secret from the server");
  });

  /**
   * The OTHER UNAVAILABLE path. Reverting the fix in `activate`'s catch left the `start()`
   * test above green — measured — because they are two different call sites and one test
   * cannot stand for both.
   */
  it("UNAVAILABLE from a failed permissions fetch carries no reason either", async () => {
    const session = riggedSession({
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("UNAVAILABLE", "a secret from the server");
      },
    });
    await session.start();
    await session.selectContext("c-a");

    const s = session.getState();
    expect(s).toEqual({ status: "UNAVAILABLE" });
    expect(JSON.stringify(s)).not.toContain("a secret from the server");
  });

  it("a freshly constructed session is IDLE, and never returns to it", async () => {
    const session = riggedSession();
    expect(session.getState()).toEqual({ status: "IDLE" });

    await session.start();
    expect(session.getState().status).not.toBe("IDLE");

    await session.selectContext("c-a");
    expect(session.getState().status).not.toBe("IDLE");
  });

  it("subscribe still does not emit on subscription", () => {
    const session = riggedSession();
    const seen: string[] = [];
    session.subscribe((s) => seen.push(s.status));
    expect(seen).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * authz-001c — the new MAJOR and the six guards nothing exercised.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("MAJOR — a duplicated pair collapses, deny-overrides", () => {
  /** A session on `c-a`, with the decisions the test dictates. */
  function decidingSession(
    fetchDecisions: AuthorizationTransport["fetchDecisions"],
    maxPairs = 10,
  ) {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-a")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions,
    };
    return createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: maxPairs });
  }

  const ask = (s: AuthorizationSession) =>
    s.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] });

  it("collapses duplicates in one response to a single entry", async () => {
    const session = decidingSession(async (_app, contextId) => ({
      app: APP,
      contextId,
      decisions: [
        { action: "read", resourceId: "r-1", effect: "PERMIT" as const },
        { action: "read", resourceId: "r-1", effect: "PERMIT" as const },
      ],
    }));
    await session.start();

    const out = await ask(session);
    expect(out).toHaveLength(1);
  });

  /**
   * THE DEFECT ITSELF. `decisionFor` read the first entry and the cache kept the last, so the
   * same question answered DENY once and PERMIT from cache ever after — with zero transport
   * calls to notice it by. Both array orders, because the bug was order-dependent.
   */
  it.each([
    ["DENY first", ["DENY", "PERMIT"] as const],
    ["PERMIT first", ["PERMIT", "DENY"] as const],
  ])("%s: answers DENY both times, the second from cache", async (_name, effects) => {
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) => ({
      app: APP,
      contextId,
      decisions: effects.map((effect) => ({ action: "read", resourceId: "r-1", effect })),
    }));
    const session = decidingSession(fetchDecisions);
    await session.start();

    const first = await ask(session);
    expect(decisionFor(first, "read", "r-1")).toBe("DENY");

    fetchDecisions.mockClear();
    const second = await ask(session);
    expect(decisionFor(second, "read", "r-1")).toBe("DENY");
    // Served from cache: the cache and the returned array cannot disagree any more.
    expect(fetchDecisions).not.toHaveBeenCalled();
  });

  it("collapses the same pair contradicting itself ACROSS two chunks", async () => {
    // maxPairs 1 splits two resource ids into two chunks; both answer about r-1.
    const session = decidingSession(
      async (_app, contextId, request) => ({
        app: APP,
        contextId,
        decisions: [
          {
            action: "read",
            resourceId: "r-1",
            effect: request.resourceIds.includes("r-1") ? ("PERMIT" as const) : ("DENY" as const),
          },
        ],
      }),
      1,
    );
    await session.start();

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1", "r-2"],
    });

    expect(out.filter((d) => d.resourceId === "r-1")).toHaveLength(1);
    expect(decisionFor(out, "read", "r-1")).toBe("DENY");
  });

  it("CONDITIONAL beats PERMIT, and is not flattened to DENY", async () => {
    const session = decidingSession(async (_app, contextId) => ({
      app: APP,
      contextId,
      decisions: [
        { action: "read", resourceId: "r-1", effect: "PERMIT" as const },
        { action: "read", resourceId: "r-1", effect: "CONDITIONAL" as const },
      ],
    }));
    await session.start();

    expect(decisionFor(await ask(session), "read", "r-1")).toBe("CONDITIONAL");
  });
});

describe("the six guards that nothing exercised", () => {
  it("U1: a superseded start() REJECTING late does not paint UNAVAILABLE over READY", async () => {
    const failing = deferred<readonly AuthorizationContext[]>();
    let call = 0;
    const session = riggedSession({
      listContexts: async () => (++call === 1 ? failing.promise : [context("c-a")]),
    });

    const first = session.start();
    await settle();
    // A second start supersedes it and settles into READY on the single context.
    await session.start();
    await settle();
    expect(session.getState().status).toBe("READY");

    failing.reject(new AuthorizationTransportError("UNAVAILABLE", "late failure"));
    await first;
    await settle();

    expect(session.getState().status).toBe("READY");
  });

  /**
   * THE MOST VALUABLE ONE. Turning an outage into "you are not authorized" is the single
   * confusion this package says must never happen — and it got worse this round, because
   * `NO_ACCESS_IN_APP` now also makes `decide` answer without asking anything.
   */
  it("U2: a plain TypeError is UNAVAILABLE, never NO_ACCESS_IN_APP", async () => {
    const fetchDecisions = vi.fn(async () => ({ app: APP, contextId: "c-a", decisions: [] }));
    const session = riggedSession({
      fetchPermissions: async () => {
        throw new TypeError("fetch failed");
      },
      fetchDecisions,
    });
    await session.start();
    await session.selectContext("c-a");

    expect(session.getState().status).toBe("UNAVAILABLE");
    expect(session.getState().status).not.toBe("NO_ACCESS_IN_APP");

    // And the second half of the blast radius: it must not silence `decide` either.
    await session.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] });
    expect(fetchDecisions).toHaveBeenCalledTimes(1);
  });

  it("U3: a menu with the right contextId and the WRONG app is UNAVAILABLE", async () => {
    const session = riggedSession({
      fetchPermissions: async (_app, contextId) => ({
        app: "another-app",
        contextId,
        permissions: [{ action: "read", effect: "PERMIT" as const }],
      }),
    });
    await session.start();
    await session.selectContext("c-a");

    expect(session.getState().status).toBe("UNAVAILABLE");
  });

  it("U4: a fractional cache bound throws RangeError at construction", () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [],
      fetchPermissions: async () => menu("c-a", []),
      fetchDecisions: async () => ({ app: APP, contextId: "c-a", decisions: [] }),
    };
    expect(() =>
      createAuthorizationSession({
        app: APP,
        transport,
        maxPairsPerRequest: 10,
        maxCachedDecisions: 2.5,
      }),
    ).toThrow(RangeError);
  });

  /**
   * U5 — the two cache protections, and what these two tests actually pin.
   *
   * 🔴 **They are NOT separable, measured.** Removing the `contextId` from `cacheKey` alone
   * leaves all 64 green, because `activate` still clears on every switch, so the cache never
   * holds two contexts at once and the key has nothing to disambiguate. Removing `activate`'s
   * clear alone also leaves all 64 green, because the key still carries the context so every
   * lookup for the new one misses anyway — the only difference is transient memory, and
   * oldest-first eviction discards precisely the stale entries first, so even a tiny
   * `maxCachedDecisions` does not expose it.
   *
   * **Removing BOTH turns these two red, plus the pre-existing cache test.** So each guard is
   * individually redundant and jointly load-bearing — the same shape the audit established for
   * `start()`'s own clear. These tests pin the property (one context's answers never serve
   * another); they do not pin either line on its own, and no test can.
   */
  it("U5a: the cache key carries the context, so one context's answer never serves another", async () => {
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) => ({
      app: APP,
      contextId,
      decisions: [
        {
          action: "read",
          resourceId: "r-1",
          effect: contextId === "c-a" ? ("PERMIT" as const) : ("DENY" as const),
        },
      ],
    }));
    const session = riggedSession({ fetchDecisions });
    await session.start();

    await session.selectContext("c-a");
    const inA = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });
    expect(decisionFor(inA, "read", "r-1")).toBe("PERMIT");

    await session.selectContext("c-b");
    const inB = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });
    expect(decisionFor(inB, "read", "r-1")).toBe("DENY");
  });

  /** The other half of the same pair — see the note above on why neither is separable. */
  it("U5b: activating a context clears the cache, so the new one is asked", async () => {
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) => ({
      app: APP,
      contextId,
      decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" as const }],
    }));
    const session = riggedSession({ fetchDecisions });
    await session.start();

    await session.selectContext("c-a");
    await session.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] });
    fetchDecisions.mockClear();

    await session.selectContext("c-b");
    await session.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] });

    expect(fetchDecisions).toHaveBeenCalledTimes(1);
  });

  it("U6: unsubscribing stops that listener and leaves the others subscribed", async () => {
    const session = riggedSession();
    const gone: string[] = [];
    const stays: string[] = [];

    const unsubscribe = session.subscribe((s) => gone.push(s.status));
    session.subscribe((s) => stays.push(s.status));

    await session.start();
    expect(gone.length).toBeGreaterThan(0);
    const seenBefore = gone.length;

    unsubscribe();
    await session.selectContext("c-a");

    expect(gone).toHaveLength(seenBefore);
    expect(stays.length).toBeGreaterThan(seenBefore);
  });
});


/* ----------------------------------------------------------------------------
 * authz-001d - the closing round.
 * -------------------------------------------------------------------------- */

describe("M1 - activate's cache clear, at the case that separates it from the key", () => {
  /**
   * The previous round concluded this guard was unprovable. It was not: every test it wrote
   * switched to a DIFFERENT context, and the `contextId` inside the cache key covers that on
   * its own. What only the clear can help with is **arriving at a context the cache already
   * holds entries for** - the same one re-selected, or one left and returned to. There the key
   * is identical by construction.
   *
   * The transport changes its answer between calls on purpose: a stub that returns the same
   * effect every time cannot see a stale hit at all.
   */
  function switchingSession() {
    let effect: "PERMIT" | "DENY" = "PERMIT";
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) => ({
      app: APP,
      contextId,
      decisions: [{ action: "read", resourceId: "r-1", effect }],
    }));
    const transport: AuthorizationTransport = {
      listContexts: async () => ctxAB,
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions,
    };
    const session = createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: 10 });
    return {
      session,
      fetchDecisions,
      say(next: "PERMIT" | "DENY") {
        effect = next;
      },
      ask: () => session.decide({ resourceType: "doc", actions: ["read"], resourceIds: ["r-1"] }),
    };
  }

  it("re-selecting the SAME context re-asks, and the answer is the current one", async () => {
    const t = switchingSession();
    await t.session.start();

    await t.session.selectContext("c-a");
    expect(decisionFor(await t.ask(), "read", "r-1")).toBe("PERMIT");
    expect(t.fetchDecisions).toHaveBeenCalledTimes(1);

    t.say("DENY");
    await t.session.selectContext("c-a"); // the same one; the key is identical
    expect(decisionFor(await t.ask(), "read", "r-1")).toBe("DENY");

    // Without the clear this is 1, and the answer is the stale PERMIT.
    expect(t.fetchDecisions).toHaveBeenCalledTimes(2);
  });

  it("leaving a context and returning to it re-asks, and the answer is the current one", async () => {
    const t = switchingSession();
    await t.session.start();

    await t.session.selectContext("c-a");
    expect(decisionFor(await t.ask(), "read", "r-1")).toBe("PERMIT");

    await t.session.selectContext("c-b");
    await t.ask();

    t.say("DENY");
    await t.session.selectContext("c-a"); // back to a context the cache once held
    expect(decisionFor(await t.ask(), "read", "r-1")).toBe("DENY");

    // Without the clear this is 2, and the third answer is the stale PERMIT.
    expect(t.fetchDecisions).toHaveBeenCalledTimes(3);
  });
});

describe("M2 - an effect the collapse does not understand is restrictive", () => {
  function withEffects(effects: readonly string[]) {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-a")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions: async (_app, contextId) => ({
        app: APP,
        contextId,
        // Deliberately outside the union: this is what a transport not written to the
        // interface, or a decision point that grew a new effect, delivers at runtime.
        decisions: effects.map((effect) => ({
          action: "read",
          resourceId: "r-1",
          effect: effect as Decision["effect"],
        })),
      }),
    };
    return createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: 10 });
  }

  it.each([
    ["unknown first", ["MAYBE", "PERMIT"]],
    ["PERMIT first", ["PERMIT", "MAYBE"]],
  ])("%s: the unknown effect wins over PERMIT and does not render", async (_name, effects) => {
    const session = withEffects(effects);
    await session.start();

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });

    expect(out).toHaveLength(1);
    const effect = decisionFor(out, "read", "r-1");
    expect(effect).not.toBe("PERMIT");
    expect(isRenderable(effect)).toBe(false);
  });
});

describe("M3 - the key encoding is injective, not merely lucky", () => {
  /** The character the old encoding joined with, and asserted could never appear in an id. */
  const SEP = "\u0000";

  /**
   * The requested pair is `("read", "r-1<SEP>x")`. Under `join(SEP)` the decision
   * `("read<SEP>r-1", "x")` encodes to the SAME string, so a membership check over that
   * encoding admits a pair nobody asked for. Length-prefixing distinguishes them by
   * construction, whatever the identifiers contain.
   */
  it("a separator inside an id does not let an unrequested pair through", async () => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-a")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions: async (_app, contextId) => ({
        app: APP,
        contextId,
        decisions: [
          { action: "read", resourceId: `r-1${SEP}x`, effect: "PERMIT" as const },
          { action: `read${SEP}r-1`, resourceId: "x", effect: "PERMIT" as const },
        ],
      }),
    };
    const session = createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: 10 });
    await session.start();

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: [`r-1${SEP}x`],
    });

    expect(out).toHaveLength(1);
    expect(out[0]?.action).toBe("read");
    expect(out[0]?.resourceId).toBe(`r-1${SEP}x`);
    expect(decisionFor(out, `read${SEP}r-1`, "x")).toBe("DENY");
  });

  /**
   * The mutation that made this necessary: replacing the length prefix with `join("|")` left
   * the suite green, because the case above forges with U+0000 only. A test that pins ONE
   * separator pins the wrong thing — what has to hold is that no character forges anything.
   * So the same forgery is run for the old separator, a printable one, and the `:` the length
   * prefix itself uses, which is the only character that could attack the new encoding.
   */
  it.each([
    ["the old NUL separator", "\u0000"],
    ["a printable separator", "|"],
    ["the length prefix's own colon", ":"],
    ["a colon with digits, aimed at the prefix", "9:"],
  ])("%s inside an id forges nothing", async (_name, sep) => {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-a")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions: async (_app, contextId) => ({
        app: APP,
        contextId,
        decisions: [
          // The pair actually requested.
          { action: "read", resourceId: `r-1${sep}x`, effect: "PERMIT" as const },
          // The forgery. Its effect DIFFERS on purpose: with a separator-joined encoding the
          // two keys are equal, so the collapse merges them under deny-overrides and the
          // requested pair comes back DENY. Giving both PERMIT would hide the collision
          // entirely, because one collapsed PERMIT looks exactly like no collision at all —
          // measured: written that way, three of four separator mutations stayed green.
          { action: `read${sep}r-1`, resourceId: "x", effect: "DENY" as const },
        ],
      }),
    };
    const session = createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: 10 });
    await session.start();

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: [`r-1${sep}x`],
    });

    expect(out).toHaveLength(1);
    // The requested pair keeps ITS answer: the forgery neither replaced it nor restricted it.
    expect(decisionFor(out, "read", `r-1${sep}x`)).toBe("PERMIT");
    expect(decisionFor(out, `read${sep}r-1`, "x")).toBe("DENY");
  });

  it.each([
    ["the old NUL separator", "\u0000"],
    ["a printable separator", "|"],
    ["the length prefix's own colon", ":"],
  ])("%s inside an id does not produce a cache hit for a different pair", async (_name, sep) => {
    const fetchDecisions = vi.fn(
      async (_app: string, contextId: string, request: DecisionRequest) => ({
        app: APP,
        contextId,
        decisions: request.resourceIds.map((resourceId: string) => ({
          action: request.actions[0] ?? "read",
          resourceId,
          effect: "PERMIT" as const,
        })),
      }),
    );
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-a")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions,
    };
    const session = createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: 10 });
    await session.start();

    // Warm the cache for ("read", "a<sep>b").
    await session.decide({ resourceType: "doc", actions: ["read"], resourceIds: [`a${sep}b`] });
    expect(fetchDecisions).toHaveBeenCalledTimes(1);

    // A DIFFERENT pair whose separator-joined encoding is identical: ("read<sep>a", "b").
    fetchDecisions.mockClear();
    await session.decide({ resourceType: "doc", actions: [`read${sep}a`], resourceIds: ["b"] });

    expect(fetchDecisions).toHaveBeenCalledTimes(1);
  });
});


/* ----------------------------------------------------------------------------
 * authz-001e - the three guards nothing pinned. Tests only, no code change.
 * -------------------------------------------------------------------------- */

describe("the three unproven guards", () => {
  /** One context, and the transport answers whatever the test dictates. */
  function pinning(fetchDecisions: AuthorizationTransport["fetchDecisions"]) {
    const transport: AuthorizationTransport = {
      listContexts: async () => [context("c-a")],
      fetchPermissions: async (_app, contextId) => menu(contextId, ["read"]),
      fetchDecisions,
    };
    return createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: 10 });
  }

  /**
   * G1 - deny-overrides between the two RESTRICTIVE effects.
   *
   * Nothing pinned this before: every earlier test compared a restrictive effect against
   * `PERMIT`, which a two-level ranking gets right by accident. With `DENY` and `CONDITIONAL`
   * ranked equally, a pair carrying both collapses to whichever arrived first - and
   * `CONDITIONAL` **renders**, so a subject sees an action the engine denied.
   *
   * Both array orders, because a two-level ranking is only wrong in one of them.
   */
  it.each([
    ["DENY first", ["DENY", "CONDITIONAL"] as const],
    ["CONDITIONAL first", ["CONDITIONAL", "DENY"] as const],
  ])("G1 %s: DENY beats CONDITIONAL and the pair does not render", async (_name, effects) => {
    const session = pinning(async (_app, contextId) => ({
      app: APP,
      contextId,
      decisions: effects.map((effect) => ({ action: "read", resourceId: "r-1", effect })),
    }));
    await session.start();

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });

    const effect = decisionFor(out, "read", "r-1");
    expect(effect).toBe("DENY");
    expect(isRenderable(effect)).toBe(false);
  });

  /**
   * G2 - the `resourceType` component of the cache key.
   *
   * Without it, a `PERMIT` computed for `doc` is served from cache for `secret`: the same
   * action and the same resource id under a different type, answered with **zero transport
   * calls**, and it renders. The transport answers differently per type so the stale hit is
   * visible; the call count is what proves it was not a cache hit.
   */
  it("G2: a decision cached for one resourceType is not served for another", async () => {
    const fetchDecisions = vi.fn(
      async (_app: string, contextId: string, request: DecisionRequest) => ({
        app: APP,
        contextId,
        decisions: [
          {
            action: "read",
            resourceId: "r-1",
            effect: request.resourceType === "doc" ? ("PERMIT" as const) : ("DENY" as const),
          },
        ],
      }),
    );
    const session = pinning(fetchDecisions);
    await session.start();

    const inDoc = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });
    expect(decisionFor(inDoc, "read", "r-1")).toBe("PERMIT");

    const inSecret = await session.decide({
      resourceType: "secret",
      actions: ["read"],
      resourceIds: ["r-1"],
    });
    expect(decisionFor(inSecret, "read", "r-1")).toBe("DENY");

    // The second call was NOT served from cache.
    expect(fetchDecisions).toHaveBeenCalledTimes(2);
  });

  /**
   * G3 - the `action` component of the requested-pair key.
   *
   * The unrequested decision arrives **alone**, and that is what makes this visible: alongside
   * the requested pair the collapse would swallow it into the same entry and nothing would
   * show. Without the action in the key it is admitted, returned, cached, and then served to
   * the later genuine query for it with zero transport calls.
   */
  it("G3: a decision for an action nobody asked about is neither returned nor cached", async () => {
    const fetchDecisions = vi.fn(async (_app: string, contextId: string) => ({
      app: APP,
      contextId,
      decisions: [{ action: "delete", resourceId: "r-1", effect: "PERMIT" as const }],
    }));
    const session = pinning(fetchDecisions);
    await session.start();

    const out = await session.decide({
      resourceType: "doc",
      actions: ["read"],
      resourceIds: ["r-1"],
    });
    expect(out).toHaveLength(0);

    fetchDecisions.mockClear();
    const later = await session.decide({
      resourceType: "doc",
      actions: ["delete"],
      resourceIds: ["r-1"],
    });

    // Not served from cache, and the answer is the transport's own.
    expect(fetchDecisions).toHaveBeenCalledTimes(1);
    expect(decisionFor(later, "delete", "r-1")).toBe("PERMIT");
  });
});
