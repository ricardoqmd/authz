import { describe, expect, it, vi } from "vitest";

import { decisionFor, isRenderable, permissionFor, type Decision } from "./decision.js";
import { createAuthorizationSession, type AuthorizationSession } from "./session.js";
import {
  AuthorizationTransportError,
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

function menu(actions: readonly string[], app = APP): PermissionMenu {
  return {
    app,
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

const REQUEST: DecisionRequest = {
  resourceType: "orders",
  actions: ["read"],
  resourceIds: ["r-1"],
};

function decisionSet(decisions: readonly Decision[], app = APP): DecisionSet {
  return { app, decisions };
}

function permitting(actions: readonly string[]): AuthorizationTransport {
  return {
    fetchPermissions: async () => menu(actions),
    fetchDecisions: async () => {
      throw new Error("not used");
    },
  };
}

function session(
  transport: AuthorizationTransport,
  over: { maxPairsPerRequest?: number; maxCachedDecisions?: number } = {},
): AuthorizationSession {
  return createAuthorizationSession({
    app: APP,
    transport,
    maxPairsPerRequest: over.maxPairsPerRequest ?? 100,
    ...(over.maxCachedDecisions === undefined
      ? {}
      : { maxCachedDecisions: over.maxCachedDecisions }),
  });
}

/* 1 — start() ------------------------------------------------------------- */

describe("createAuthorizationSession — start()", () => {
  it("goes LOADING then READY with the menu, and never lingers on a previous READY", async () => {
    const seen: string[] = [];
    const s = session(permitting(["read"]));
    s.subscribe((st) => seen.push(st.status));

    await s.start();
    expect(s.getState()).toEqual({
      status: "READY",
      permissions: [{ action: "read", effect: "PERMIT" }],
    });

    await s.start();

    // A second start() goes through LOADING again rather than holding the old READY on screen.
    expect(seen).toEqual(["LOADING", "READY", "LOADING", "READY"]);
  });

  it("is UNAVAILABLE when the permissions fetch rejects, never READY with an empty menu", async () => {
    const s = session({
      fetchPermissions: async () => {
        throw new Error("the decision point is down");
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });

    await s.start();

    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });
  });

  it("is NO_ACCESS_IN_APP when the permissions fetch rejects with that kind", async () => {
    const s = session({
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("NO_ACCESS_IN_APP", "not for you");
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });

    await s.start();

    // Distinct from a READY with an empty menu: "you may not enter" is a different screen from
    // "you may enter and may do nothing". Collapsing the two is what this state prevents.
    expect(s.getState()).toEqual({ status: "NO_ACCESS_IN_APP" });
  });

  it("a plain TypeError is UNAVAILABLE, never NO_ACCESS_IN_APP", async () => {
    const s = session({
      fetchPermissions: async () => {
        throw new TypeError("undefined is not a function");
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });

    await s.start();

    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });
  });

  it("a menu labelled with the WRONG app is UNAVAILABLE, not READY", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"], "app-b"),
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });

    await s.start();

    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });
  });
});

/* 2 — the generation protocol -------------------------------------------- */

describe("start() joins the generation protocol", () => {
  it("a first start() resolving late does not paint over the second one's READY", async () => {
    const slow = deferred<PermissionMenu>();
    let call = 0;
    const s = session({
      fetchPermissions: async () => {
        call += 1;
        return call === 1 ? slow.promise : menu(["write"]);
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });

    const first = s.start();
    await settle();
    await s.start();
    expect(s.getState()).toMatchObject({ status: "READY" });

    slow.resolve(menu(["read"]));
    await first;
    await settle();

    expect(s.getState()).toEqual({
      status: "READY",
      permissions: [{ action: "write", effect: "PERMIT" }],
    });
  });

  it("a superseded start() REJECTING late does not paint UNAVAILABLE over READY", async () => {
    const slow = deferred<PermissionMenu>();
    let call = 0;
    const s = session({
      fetchPermissions: async () => {
        call += 1;
        return call === 1 ? slow.promise : menu(["write"]);
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });

    const first = s.start();
    await settle();
    await s.start();

    slow.reject(new Error("too late"));
    await first;
    await settle();

    expect(s.getState()).toMatchObject({ status: "READY" });
  });

  it("E: decisions resolving after a later start() are [] and are not cached", async () => {
    const slow = deferred<DecisionSet>();
    let decisionCalls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        decisionCalls += 1;
        return decisionCalls === 1
          ? slow.promise
          : decisionSet([{ action: "read", resourceId: "r-1", effect: "DENY" }]);
      },
    });

    await s.start();
    const inFlight = s.decide(REQUEST);
    await settle();

    await s.start();
    slow.resolve(decisionSet([{ action: "read", resourceId: "r-1", effect: "PERMIT" }]));

    expect(await inFlight).toEqual([]);

    // And nothing from it was cached: the next call asks again and gets the current answer.
    const after = await s.decide(REQUEST);
    expect(decisionFor(after, "read", "r-1")).toBe("DENY");
  });
});

/* 3 — decide() ------------------------------------------------------------ */

describe("createAuthorizationSession — decide", () => {
  it("answers nothing before start(), so every pair denies", async () => {
    const s = session(permitting(["read"]));

    expect(await s.decide(REQUEST)).toEqual([]);
    expect(decisionFor(await s.decide(REQUEST), "read", "r-1")).toBe("DENY");
  });

  it("asks one call per chunk and merges what came back", async () => {
    const seen: DecisionRequest[] = [];
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) => {
          seen.push(request);
          return decisionSet(
            request.resourceIds.map((resourceId) => ({
              action: "read",
              resourceId,
              effect: "PERMIT" as const,
            })),
          );
        },
      },
      { maxPairsPerRequest: 2 },
    );

    await s.start();
    const out = await s.decide({
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1", "r-2", "r-3"],
    });

    expect(seen).toHaveLength(2);
    expect(out).toHaveLength(3);
  });

  it("denies only the pairs of the chunk that failed, and does not reject", async () => {
    let call = 0;
    const seen: DecisionRequest[] = [];
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) => {
          seen.push(request);
          call += 1;
          if (call === 1) {
            throw new Error("chunk down");
          }
          return decisionSet(
            request.resourceIds.map((resourceId) => ({
              action: "read",
              resourceId,
              effect: "PERMIT" as const,
            })),
          );
        },
      },
      { maxPairsPerRequest: 1 },
    );

    await s.start();
    const out = await s.decide({
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1", "r-2"],
    });

    expect(decisionFor(out, "read", "r-1")).toBe("DENY");
    expect(decisionFor(out, "read", "r-2")).toBe("PERMIT");

    // AND every chunk respected the cap the session was built with. Without this, a splitter that
    // over-fills a chunk still produced the two answers above and this test stayed green.
    for (const chunk of seen) {
      expect(chunk.actions.length * chunk.resourceIds.length).toBeLessThanOrEqual(1);
    }
  });

  it("serves a fully cached request without asking again, and a re-start clears the cache", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        calls += 1;
        return decisionSet([{ action: "read", resourceId: "r-1", effect: "PERMIT" }]);
      },
    });

    await s.start();
    await s.decide(REQUEST);
    await s.decide(REQUEST);
    expect(calls).toBe(1);

    // `start()` clears the cache, so the next question is asked again.
    await s.start();
    await s.decide(REQUEST);
    expect(calls).toBe(2);
  });

  it.each([
    ["an action", { actions: ["read", "write"], resourceIds: ["r-1"] }],
    ["a resource", { actions: ["read"], resourceIds: ["r-1", "r-2"] }],
  ] as const)("a request that adds %s to one already cached is asked, and answered for every pair", async (_n, more) => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async (_app, request) => {
        calls += 1;
        return decisionSet(
          request.actions.flatMap((action) => request.resourceIds.map((resourceId) => ({ action, resourceId, effect: "PERMIT" as const }))),
        );
      },
    });
    await s.start();
    await s.decide(REQUEST);

    const decided = await s.decide({ resourceType: REQUEST.resourceType, ...more });

    expect([calls, ...more.actions.flatMap((a) => more.resourceIds.map((r) => decisionFor(decided, a, r)))]).toEqual([
      2,
      "PERMIT",
      "PERMIT",
    ]);
  });

  it("honours NO_ACCESS_IN_APP and returns [] without calling the transport", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("NO_ACCESS_IN_APP");
      },
      fetchDecisions: async () => {
        calls += 1;
        return decisionSet([]);
      },
    });

    await s.start();
    expect(await s.decide(REQUEST)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("drops a decision whose pair was not requested, and does not cache it", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        calls += 1;
        return decisionSet([
          { action: "read", resourceId: "r-1", effect: "PERMIT" },
          { action: "delete", resourceId: "r-9", effect: "PERMIT" },
        ]);
      },
    });

    await s.start();
    const out = await s.decide(REQUEST);

    expect(out).toHaveLength(1);
    expect(decisionFor(out, "delete", "r-9")).toBe("DENY");

    // And it was not cached: asking about it goes back to the transport.
    await s.decide({ resourceType: "orders", actions: ["delete"], resourceIds: ["r-9"] });
    expect(calls).toBe(2);
  });

  it("discards a whole response whose app is not this session's", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        decisionSet([{ action: "read", resourceId: "r-1", effect: "PERMIT" }], "app-b"),
    });

    await s.start();

    expect(await s.decide(REQUEST)).toEqual([]);
  });

  it("a decision cached for one resourceType is not served for another", async () => {
    const asked: string[] = [];
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async (_app, request) => {
        asked.push(request.resourceType);
        return decisionSet([{ action: "read", resourceId: "r-1", effect: "PERMIT" }]);
      },
    });

    await s.start();
    await s.decide(REQUEST);
    await s.decide({ resourceType: "invoices", actions: ["read"], resourceIds: ["r-1"] });

    expect(asked).toEqual(["orders", "invoices"]);
  });

  it("a decision for an action nobody asked about is neither returned nor cached", async () => {
    // The response carries ONLY the unrequested action, so the answer must be EMPTY. A pair key
    // that dropped the action would find this in the requested set and return it.
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        calls += 1;
        return decisionSet([{ action: "delete", resourceId: "r-1", effect: "PERMIT" }]);
      },
    });

    await s.start();
    expect(await s.decide(REQUEST)).toHaveLength(0);

    // Not served from cache either: the later genuine question reaches the transport.
    const later = await s.decide({
      resourceType: "orders",
      actions: ["delete"],
      resourceIds: ["r-1"],
    });
    expect(calls).toBe(2);
    expect(decisionFor(later, "delete", "r-1")).toBe("PERMIT");
  });

  /**
   * The encoding is injective, and that is a property of the ENCODING, not of the values.
   *
   * The requested pair is `("read", "r-1<sep>x")`. Under a plain `join(sep)` the decision
   * `("read<sep>r-1", "x")` encodes to the SAME string, so a membership check over that encoding
   * admits a pair nobody asked for. Length-prefixing distinguishes them by construction.
   *
   * THE FORGERY'S EFFECT DIFFERS ON PURPOSE. With a separator-joined encoding the two keys are
   * equal, so the collapse merges them under deny-overrides and the requested pair comes back
   * DENY. Giving both PERMIT would hide the collision entirely — one collapsed PERMIT looks exactly
   * like no collision at all — so an encoding that collided would pass unseen.
   */
  it.each([
    ["the NUL an earlier encoding used", "\u0000"],
    ["a printable pipe", "|"],
    ["the length prefix's own colon", ":"],
    ["a colon with digits, aimed at the prefix", "9:"],
  ] as const)("%s inside an id forges no other pair's key", async (_n, sep) => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        decisionSet([
          { action: "read", resourceId: `r-1${sep}x`, effect: "PERMIT" },
          { action: `read${sep}r-1`, resourceId: "x", effect: "DENY" },
        ]),
    });

    await s.start();
    const out = await s.decide({
      resourceType: "orders",
      actions: ["read"],
      resourceIds: [`r-1${sep}x`],
    });

    expect(out).toHaveLength(1);
    // The requested pair keeps ITS answer: the forgery neither replaced it nor restricted it.
    expect(decisionFor(out, "read", `r-1${sep}x`)).toBe("PERMIT");
    expect(decisionFor(out, `read${sep}r-1`, "x")).toBe("DENY");
  });

  it.each([
    ["the NUL an earlier encoding used", "\u0000"],
    ["a printable pipe", "|"],
    ["the length prefix's own colon", ":"],
  ] as const)(
    "%s inside an id does not produce a cache hit for a different pair",
    async (_n, sep) => {
      let calls = 0;
      const s = session({
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) => {
          calls += 1;
          return decisionSet(
            request.resourceIds.map((resourceId) => ({
              action: request.actions[0] ?? "read",
              resourceId,
              effect: "PERMIT" as const,
            })),
          );
        },
      });

      await s.start();
      // Warm the cache for ("read", "a<sep>b").
      await s.decide({ resourceType: "orders", actions: ["read"], resourceIds: [`a${sep}b`] });
      expect(calls).toBe(1);

      // A DIFFERENT pair whose separator-joined encoding is identical: ("read<sep>a", "b").
      await s.decide({ resourceType: "orders", actions: [`read${sep}a`], resourceIds: ["b"] });
      expect(calls).toBe(2);
    },
  );

});

/* 4 — duplicate collapse -------------------------------------------------- */

describe("a duplicated pair collapses, deny-overrides", () => {
  // BOTH ORDERS, and that is the point: a collapse that simply keeps the LAST entry answers
  // correctly for [PERMIT, DENY] and wrongly for [DENY, PERMIT]. One order proves nothing.
  it.each([
    ["PERMIT first", ["PERMIT", "DENY"]],
    ["DENY first", ["DENY", "PERMIT"]],
  ] as const)("collapses duplicates in one response to a single DENY — %s", async (_n, effects) => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        decisionSet(
          effects.map((effect) => ({ action: "read", resourceId: "r-1", effect })),
        ),
    });

    await s.start();
    const out = await s.decide(REQUEST);

    expect(out).toHaveLength(1);
    expect(decisionFor(out, "read", "r-1")).toBe("DENY");
  });

  // Deny-overrides between the two RESTRICTIVE effects, which is where a rank table that
  // collapses them, or inverts them, still passes every PERMIT-versus-something test.
  it.each([
    ["DENY first", ["DENY", "CONDITIONAL"]],
    ["CONDITIONAL first", ["CONDITIONAL", "DENY"]],
  ] as const)("%s: DENY beats CONDITIONAL", async (_n, effects) => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        decisionSet(
          effects.map((effect) => ({ action: "read", resourceId: "r-1", effect })),
        ),
    });

    await s.start();
    expect(decisionFor(await s.decide(REQUEST), "read", "r-1")).toBe("DENY");
  });

  it("collapses the same pair contradicting itself ACROSS two chunks", async () => {
    let call = 0;
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async () => {
          call += 1;
          return decisionSet([
            {
              action: "read",
              resourceId: "r-1",
              effect: call === 1 ? "PERMIT" : "DENY",
            },
          ]);
        },
      },
      { maxPairsPerRequest: 1 },
    );

    await s.start();
    const out = await s.decide({
      resourceType: "orders",
      actions: ["read", "read"],
      resourceIds: ["r-1"],
    });

    expect(out).toHaveLength(1);
    expect(decisionFor(out, "read", "r-1")).toBe("DENY");

    // And the cache agrees with what was returned, so the answer cannot flip on the next call.
    expect(decisionFor(await s.decide(REQUEST), "read", "r-1")).toBe("DENY");
  });

  it("CONDITIONAL beats PERMIT, and is not flattened to DENY", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        decisionSet([
          { action: "read", resourceId: "r-1", effect: "PERMIT" },
          { action: "read", resourceId: "r-1", effect: "CONDITIONAL" },
        ]),
    });

    await s.start();
    expect(decisionFor(await s.decide(REQUEST), "read", "r-1")).toBe("CONDITIONAL");
  });

  it.each([
    ["PERMIT first", ["PERMIT", "SOMETHING_NEW"]],
    ["unknown first", ["SOMETHING_NEW", "PERMIT"]],
  ] as const)(
    "%s: an effect the collapse does not understand is restrictive, never permissive",
    async (_n, effects) => {
      const s = session({
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async () =>
          decisionSet(
            effects.map((effect) => ({
              action: "read",
              resourceId: "r-1",
              effect: effect as unknown as Decision["effect"],
            })),
          ),
      });

      await s.start();
      const out = await s.decide(REQUEST);

      expect(out).toHaveLength(1);
      expect(out[0]?.effect).toBe("SOMETHING_NEW");
    },
  );
});

/* 5 — the cache bound ----------------------------------------------------- */

describe("the decision cache is bounded", () => {
  it("evicts OLDEST-first, and an evicted pair is asked again", async () => {
    // A bound of 2 and three pairs asked one at a time. With a bound of 1 an eviction policy that
    // picked the NEWEST would be indistinguishable — there is only one entry to pick.
    let calls = 0;
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) => {
          calls += 1;
          return decisionSet(
            request.resourceIds.map((resourceId) => ({
              action: "read",
              resourceId,
              effect: "PERMIT" as const,
            })),
          );
        },
      },
      { maxCachedDecisions: 2 },
    );

    await s.start();
    const ask = (id: string) =>
      s.decide({ resourceType: "orders", actions: ["read"], resourceIds: [id] });

    await ask("r-1");
    await ask("r-2");
    await ask("r-3"); // evicts r-1, the OLDEST
    expect(calls).toBe(3);

    await ask("r-2"); // still cached
    expect(calls).toBe(3);

    await ask("r-1"); // evicted: has to be asked again
    expect(calls).toBe(4);
  });

  it("rejects a bound below 1 at construction", () => {
    expect(() => session(permitting(["read"]), { maxCachedDecisions: 0 })).toThrow(RangeError);
  });

  it("a fractional cache bound throws RangeError at construction", () => {
    expect(() => session(permitting(["read"]), { maxCachedDecisions: 1.5 })).toThrow(RangeError);
  });
});

/* 6 — the state surface --------------------------------------------------- */

describe("the state surface", () => {
  it("a freshly constructed session is IDLE", () => {
    expect(session(permitting(["read"])).getState()).toEqual({ status: "IDLE" });
  });

  it("subscribe does not emit on subscription", () => {
    const seen: string[] = [];
    session(permitting(["read"])).subscribe((st) => seen.push(st.status));
    expect(seen).toEqual([]);
  });

  it("UNAVAILABLE carries no reason, from either path that reaches it", async () => {
    const rejecting = session({
      fetchPermissions: async () => {
        throw new Error("secret detail from someone else's server");
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });
    await rejecting.start();
    expect(Object.keys(rejecting.getState())).toEqual(["status"]);

    const mislabelled = session({
      fetchPermissions: async () => menu(["read"], "app-b"),
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });
    await mislabelled.start();
    expect(Object.keys(mislabelled.getState())).toEqual(["status"]);
  });

  it("unsubscribing stops that listener and leaves the others subscribed", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const s = session(permitting(["read"]));
    const offA = s.subscribe((st) => a.push(st.status));
    s.subscribe((st) => b.push(st.status));

    offA();
    await s.start();

    expect(a).toEqual([]);
    expect(b).toEqual(["LOADING", "READY"]);
  });
});

/* 7 — close() ------------------------------------------------------------- */

describe("a closed session answers nothing", () => {
  it("returns [] for a pair that answered PERMIT from cache one call earlier", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        decisionSet([{ action: "read", resourceId: "r-1", effect: "PERMIT" }]),
    });
    await s.start();
    expect(decisionFor(await s.decide(REQUEST), "read", "r-1")).toBe("PERMIT");

    s.close();

    expect(await s.decide(REQUEST)).toEqual([]);
    expect(decisionFor(await s.decide(REQUEST), "read", "r-1")).toBe("DENY");
  });

  it("lands on IDLE", async () => {
    const s = session(permitting(["read"]));
    await s.start();
    s.close();
    expect(s.getState()).toEqual({ status: "IDLE" });
  });

  it("start() calls the transport zero times and leaves IDLE", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => {
        calls += 1;
        return menu(["read"]);
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });
    await s.start();
    const before = calls;
    s.close();

    await s.start();

    expect(calls).toBe(before);
    expect(s.getState()).toEqual({ status: "IDLE" });
  });

  it("subscribe() after close() registers nothing and its unsubscribe is safe", async () => {
    const s = session(permitting(["read"]));
    await s.start();
    s.close();

    const late: string[] = [];
    const off = s.subscribe((st) => late.push(st.status));
    await s.start();

    expect(late).toEqual([]);
    expect(() => off()).not.toThrow();
  });

  it("a decide() already in flight contributes nothing and caches nothing", async () => {
    const slow = deferred<DecisionSet>();
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        calls += 1;
        return slow.promise;
      },
    });
    await s.start();
    const inFlight = s.decide(REQUEST);
    await settle();

    s.close();
    slow.resolve(decisionSet([{ action: "read", resourceId: "r-1", effect: "PERMIT" }]));

    expect(await inFlight).toEqual([]);
    expect(await s.decide(REQUEST)).toEqual([]);
    expect(calls).toBe(1);
  });

  it("close() twice does not throw and emits only once", async () => {
    const seen: string[] = [];
    const s = session(permitting(["read"]));
    await s.start();
    s.subscribe((st) => seen.push(st.status));

    s.close();
    expect(() => s.close()).not.toThrow();

    expect(seen).toEqual(["IDLE"]);
  });

  it("emits ONE final IDLE and only then drops every listener", async () => {
    const seen: string[] = [];
    const s = session(permitting(["read"]));
    await s.start();
    s.subscribe((st) => seen.push(st.status));

    s.close();

    // The emission comes BEFORE the drop: a framework binding gets its one render to clear the
    // screen. Dropping first would leave the previous subject's menu painted, which is the leak
    // close() exists to close.
    expect(seen).toEqual(["IDLE"]);
    await s.start();
    expect(seen).toEqual(["IDLE"]);
  });
});

describe("close() is final: the flag is set before the last emission", () => {
  it("a listener that calls start() from the final IDLE leaves the session IDLE", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => {
        calls += 1;
        return menu(["read"]);
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });
    await s.start();
    const before = calls;

    let reentered: Promise<void> | undefined;
    s.subscribe((st) => {
      if (st.status === "IDLE" && reentered === undefined) {
        reentered = s.start();
      }
    });

    s.close();
    await reentered;
    await settle();

    // With the flag set after the emission, this left a CLOSED session READY with a permission
    // menu, the transport called after close(), and decide() answering PERMIT.
    expect(s.getState()).toEqual({ status: "IDLE" });
    expect(calls).toBe(before);
    expect(await s.decide(REQUEST)).toEqual([]);
  });

  it("a listener that re-enters close() from the final IDLE does not recurse", async () => {
    const s = session(permitting(["read"]));
    await s.start();

    let emissions = 0;
    s.subscribe(() => {
      emissions += 1;
      // With the flag set after the emission this recursed until the stack ran out.
      s.close();
    });

    expect(() => s.close()).not.toThrow();
    expect(emissions).toBe(1);
  });

  it("a listener subscribed after close() receives nothing, on a session someone resurrected", async () => {
    const s = session(permitting(["read"]));
    await s.start();

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

/* 8 — a listener cannot take the session down ----------------------------- */

describe("a subscribed listener cannot take the session down", () => {
  it("does not deny the notification to a listener subscribed after it", async () => {
    const seen: string[] = [];
    const s = session(permitting(["read"]));
    s.subscribe(() => {
      throw new Error("render bug");
    });
    s.subscribe((st) => seen.push(st.status));

    await s.start();

    expect(seen).toEqual(["LOADING", "READY"]);
  });

  it("does not break start(): the call resolves and the session still reaches its state", async () => {
    const s = session(permitting(["read"]));
    s.subscribe(() => {
      throw new Error("render bug");
    });

    await expect(s.start()).resolves.toBeUndefined();
    expect(s.getState()).toMatchObject({ status: "READY" });
  });

  it("does not break close(): the emission still reaches the listeners after the thrower", async () => {
    const seen: string[] = [];
    const s = session(permitting(["read"]));
    await s.start();
    s.subscribe(() => {
      throw new Error("render bug");
    });
    s.subscribe((st) => seen.push(st.status));

    expect(() => s.close()).not.toThrow();

    // The try wraps EACH listener, not the loop. Wrapping the loop would stop at the thrower and
    // the listeners after it would lose the final IDLE — which is the one render a binding needs
    // to clear the screen.
    expect(seen).toEqual(["IDLE"]);

    // Inert: a second close() is a no-op rather than a second throw, and the session answers
    // nothing. Before the throw was contained, this path left the session permanently unclosable.
    expect(() => s.close()).not.toThrow();
    expect(s.getState()).toEqual({ status: "IDLE" });
    expect(await s.decide(REQUEST)).toEqual([]);
  });

  it("close() after a thrower is still idempotent", async () => {
    const s = session(permitting(["read"]));
    await s.start();
    const spy = vi.fn(() => {
      throw new Error("render bug");
    });
    s.subscribe(spy);

    s.close();
    s.close();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("the two screens the state type exists to separate", () => {
  // One direction was already pinned: a NO_ACCESS_IN_APP is not reported as a READY. The other
  // was not, and it is the half that fails toward the wrong screen — nothing stopped a subject
  // who legitimately may enter and may do nothing from being told "you may not enter".
  it("a menu with zero permissions is READY with an empty menu, not NO_ACCESS_IN_APP", async () => {
    const s = session(permitting([]));

    await s.start();

    expect(s.getState()).toEqual({ status: "READY", permissions: [] });
    expect(s.getState().status).not.toBe("NO_ACCESS_IN_APP");
  });

  it("and NO_ACCESS_IN_APP is not a READY with an empty menu", async () => {
    const s = session({
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("NO_ACCESS_IN_APP", "denied");
      },
      fetchDecisions: async () => {
        throw new Error("not used");
      },
    });

    await s.start();

    expect(s.getState()).toEqual({ status: "NO_ACCESS_IN_APP" });
  });
});

describe("decide() outside READY", () => {
  // The package makes exactly one behavioural decision here, and until now nothing pinned it in
  // either direction: decide() short-circuits in IDLE and in NO_ACCESS_IN_APP, and KEEPS ASKING in
  // LOADING and in UNAVAILABLE.
  //
  // The reason for the asymmetry is that the two pairs answer different questions. IDLE and
  // NO_ACCESS_IN_APP are statements about the subject — nobody started, or the decision point said
  // no — and asking anyway would either invent a session or contradict an answer already received.
  // LOADING and UNAVAILABLE are statements about the MENU, and the menu is not what authorises: a
  // decision request is its own question, and refusing to ask it would turn a slow or failed menu
  // fetch into a silent denial of everything.
  //
  // A declared decision with no test is a decision the next edit reverses silently, so both
  // directions are pinned here.

  it("keeps asking while the menu is still LOADING", async () => {
    const menuGate = deferred<PermissionMenu>();
    const fetchDecisions = vi.fn(async () =>
      decisionSet([{ action: "read", resourceId: "r-1", effect: "PERMIT" }]),
    );
    const s = session({ fetchPermissions: () => menuGate.promise, fetchDecisions });

    const starting = s.start();
    await settle();
    expect(s.getState()).toEqual({ status: "LOADING" });

    const out = await s.decide(REQUEST);

    expect(fetchDecisions).toHaveBeenCalledTimes(1);
    expect(decisionFor(out, "read", "r-1")).toBe("PERMIT");

    menuGate.resolve(menu(["read"]));
    await starting;
  });

  it("keeps asking after the menu came back UNAVAILABLE", async () => {
    const fetchDecisions = vi.fn(async () =>
      decisionSet([{ action: "read", resourceId: "r-1", effect: "PERMIT" }]),
    );
    const s = session({
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("UNAVAILABLE", "down");
      },
      fetchDecisions,
    });

    await s.start();
    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });

    const out = await s.decide(REQUEST);

    expect(fetchDecisions).toHaveBeenCalledTimes(1);
    expect(decisionFor(out, "read", "r-1")).toBe("PERMIT");
  });

  it("asks nothing in IDLE and in NO_ACCESS_IN_APP", async () => {
    const fetchDecisions = vi.fn(async () => decisionSet([]));

    const idle = session({ fetchPermissions: async () => menu([]), fetchDecisions });
    expect(await idle.decide(REQUEST)).toEqual([]);

    const denied = session({
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("NO_ACCESS_IN_APP", "denied");
      },
      fetchDecisions,
    });
    await denied.start();
    expect(await denied.decide(REQUEST)).toEqual([]);

    expect(fetchDecisions).not.toHaveBeenCalled();
  });
});

describe("two guards the family map claimed were load-bearing and nothing exercised", () => {
  // pairsOf iterates EVERY action, not just the first. Truncating it to the first action
  // left the whole suite green: nothing asked about two actions at once and checked both answers.
  // The failure is quiet and toward open in a specific way — the pairs that were never asked for
  // are absent from the response, and absent resolves to DENY, so a subject loses permissions they
  // hold rather than gaining ones they do not. It is still wrong, and it is invisible.
  it("asks about every action, not only the first", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async (_app, request) =>
        decisionSet(
          request.actions.flatMap((action) =>
            request.resourceIds.map((resourceId) => ({
              action,
              resourceId,
              effect: "PERMIT" as const,
            })),
          ),
        ),
    });
    await s.start();

    const out = await s.decide({
      resourceType: "orders",
      actions: ["read", "update"],
      resourceIds: ["r-1"],
    });

    expect(decisionFor(out, "read", "r-1")).toBe("PERMIT");
    expect(decisionFor(out, "update", "r-1")).toBe("PERMIT");
  });

  // The collapse is STABLE on a tie. rank() maps PERMIT to 0, CONDITIONAL to 1 and
  // everything else to 2, so DENY and an effect outside the union have the SAME rank. Which of the
  // two survives is then decided by the comparison operator alone, and `>` keeps the one that
  // arrived first.
  //
  // Neither renders, so no button changes — but the effect string the consumer reads does, and a
  // value that flips depending on arrival order is the kind of thing a consumer eventually
  // branches on. Pinned so the operator cannot drift to `>=` unnoticed.
  it("collapses a tie to the effect that arrived first", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        decisionSet([
          { action: "read", resourceId: "r-1", effect: "DENY" },
          { action: "read", resourceId: "r-1", effect: "SOMETHING_NEW" as Decision["effect"] },
        ]),
    });
    await s.start();

    const out = await s.decide(REQUEST);

    expect(out).toHaveLength(1);
    expect(out[0]?.effect).toBe("DENY");
  });
});

/* 9 — an answer that does not say what it answers ------------------------- */

/**
 * The transport casts what arrives over the wire, so the field types of a decision and of a menu
 * entry are a hope and not a guarantee. `raw` is that cast and nothing else.
 *
 * Every call below is read through `outcome` rather than awaited bare: before these guards existed
 * the calls REJECTED with a `TypeError`, and a test that awaits bare would fail with that error
 * instead of with the assertion that names what went wrong.
 */
function raw(...decisions: readonly unknown[]): DecisionSet {
  return { app: APP, decisions: decisions as readonly Decision[] };
}

async function outcome<T>(call: Promise<T>): Promise<{ value: T } | { rejected: string }> {
  return call.then(
    (value) => ({ value }),
    (error: unknown) => ({ rejected: String(error) }),
  );
}

const PERMIT_R1: Decision = { action: "read", resourceId: "r-1", effect: "PERMIT" };

describe("an element that does not name its pair is discarded, and nothing beside it is", () => {
  // Both halves in one response: elements that name no pair, which are dropped, and one that names
  // its pair with no effect, which stays and reads DENY. The well-formed answer beside them is
  // returned either way; one response is one arrival, so the order is the order it was sent in.
  it("a chunk carrying malformed elements still returns its well-formed one", async () => {
    const noEffect = { action: "read", resourceId: "r-2" };
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        raw(
          { action: "read", effect: "DENY" },
          { resourceId: "r-3", effect: "DENY" },
          null,
          "read",
          { action: "read", resourceId: 3, effect: "DENY" },
          noEffect,
          PERMIT_R1,
        ),
    });
    await s.start();

    const got = await outcome(
      s.decide({ resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2", "r-3"] }),
    );

    expect(got).toEqual({ value: [noEffect, PERMIT_R1] });
    const out = "value" in got ? got.value : [];
    expect(["r-1", "r-2", "r-3"].map((r) => decisionFor(out, "read", r))).toEqual([
      "PERMIT",
      "DENY",
      "DENY",
    ]);
  });

  it("a chunk whose element is malformed does not fail the chunk beside it", async () => {
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) =>
          request.resourceIds[0] === "r-1"
            ? raw({ action: "read", effect: "PERMIT" })
            : raw({ action: "read", resourceId: "r-2", effect: "PERMIT" }),
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();

    const got = await outcome(
      s.decide({ resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] }),
    );

    expect(got).toEqual({ value: [{ action: "read", resourceId: "r-2", effect: "PERMIT" }] });
  });

  // An id that is not a string can still have a length and a string form, and the pair key is
  // built from exactly those two: `{ length: 15 }` spells the key of "[object Object]".
  const KEY = "[object Object]";
  it.each([
    ["resourceId", { action: "read", resourceId: { length: 15 }, effect: "PERMIT" }, "read", KEY],
    ["action", { action: { length: 15 }, resourceId: "r-1", effect: "PERMIT" }, KEY, "r-1"],
  ] as const)("a non-string %s answers no pair, even the one its key spells", async (...row) => {
    const [, el, a, r] = row;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => raw(el),
    });
    await s.start();

    const got = await outcome(s.decide({ resourceType: "orders", actions: [a], resourceIds: [r] }));

    expect(got).toEqual({ value: [] });
  });

  it("an empty resource id the request carried is answered, not discarded", async () => {
    const answer: Decision = { action: "read", resourceId: "", effect: "PERMIT" };
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => raw(answer),
    });
    await s.start();

    const got = await outcome(
      s.decide({ resourceType: "orders", actions: ["read"], resourceIds: [""] }),
    );

    expect(got).toEqual({ value: [answer] });
  });

  it("fields beyond the three do not make an element malformed", async () => {
    const answer = { ...PERMIT_R1, policy: "p-9", dependsOn: ["resource.areaId"] };
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => raw(answer),
    });
    await s.start();

    const got = await outcome(s.decide(REQUEST));

    expect(got).toEqual({ value: [answer] });
  });

  // An element that names its pair and carries no effect is NOT discarded. It answers a pair that
  // was asked, with an effect nobody can read, and the collapse already ranks it above PERMIT.
  // Discarding it instead would leave the PERMIT beside it alone, and the pair would render.
  it.each([
    ["PERMIT first", [PERMIT_R1, { action: "read", resourceId: "r-1" }]],
    ["no effect first", [{ action: "read", resourceId: "r-1" }, PERMIT_R1]],
  ] as const)("%s: a pair answered once with no effect reads DENY, not PERMIT", async (_n, els) => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => raw(...els),
    });
    await s.start();

    const got = await outcome(s.decide(REQUEST));
    const effect = "value" in got ? decisionFor(got.value, "read", "r-1") : got.rejected;

    expect([effect, isRenderable(effect as Decision["effect"])]).toEqual(["DENY", false]);
  });
});

describe("a chunk whose answer holds no list is dropped, and the chunk beside it is not", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an object with no decisions field", { app: APP }],
    ["an object whose decisions is null", { app: APP, decisions: null }],
    ["a string", "read"],
  ] as const)("%s", async (_n, envelope) => {
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) =>
          request.resourceIds[0] === "r-1"
            ? (envelope as unknown as DecisionSet)
            : raw({ action: "read", resourceId: "r-2", effect: "PERMIT" }),
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();

    const got = await outcome(
      s.decide({ resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] }),
    );

    expect(got).toEqual({ value: [{ action: "read", resourceId: "r-2", effect: "PERMIT" }] });
  });
});

describe("a menu that is not a menu, and menu entries that name no action", () => {
  // `start()` used to throw reading `app` from `null`, and the state stayed LOADING for good.
  it.each([
    ["null", null],
    ["a string", "read"],
    ["an object with no permissions array", { app: APP }],
    ["a permissions field that is not an array", { app: APP, permissions: "read" }],
  ] as const)("%s is UNAVAILABLE, and start() resolves", async (_n, answer) => {
    const s = session({
      fetchPermissions: async () => answer as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    const got = await outcome(s.start());

    expect([got, s.getState()]).toEqual([{ value: undefined }, { status: "UNAVAILABLE" }]);
  });

  // The entry with no effect STAYS: it names its action, and it reads DENY through permissionFor.
  // Only what no lookup could ever match is dropped.
  it("READY carries only the entries that name their action", async () => {
    const s = session({
      fetchPermissions: async () =>
        ({
          app: APP,
          permissions: [
            null,
            { effect: "PERMIT" },
            "read",
            { action: 7, effect: "PERMIT" },
            { action: "read", effect: "PERMIT" },
            { action: "write" },
          ],
        }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    const got = await outcome(s.start());
    const state = s.getState();

    expect([got, state]).toEqual([
      { value: undefined },
      { status: "READY", permissions: [{ action: "read", effect: "PERMIT" }, { action: "write" }] },
    ]);
    const permissions = state.status === "READY" ? state.permissions : [];
    expect(permissionFor(permissions, "write")).toBe("DENY");
  });

  // BOTH ORDERS, for the reason the decision collapse gives: keeping the first entry answers one
  // order correctly and the other wrongly. The entry with no effect is the case an effect-aware
  // filter would get wrong in a way no single-entry menu shows: dropped, it leaves PERMIT alone.
  const READ_PERMIT = { action: "read", effect: "PERMIT" };
  const READ_DENY = { action: "read", effect: "DENY" };
  const READ_NO_EFFECT = { action: "read" };
  it.each([
    ["PERMIT then DENY", [READ_PERMIT, READ_DENY]],
    ["DENY then PERMIT", [READ_DENY, READ_PERMIT]],
    ["PERMIT then no effect", [READ_PERMIT, READ_NO_EFFECT]],
    ["no effect then PERMIT", [READ_NO_EFFECT, READ_PERMIT]],
  ] as const)("%s: an action listed twice is one entry, and it does not render", async (...row) => {
    const [, entries] = row;
    const s = session({
      fetchPermissions: async () =>
        ({ app: APP, permissions: entries }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    await outcome(s.start());
    const state = s.getState();
    const permissions = state.status === "READY" ? state.permissions : [];

    expect([permissions.length, permissionFor(permissions, "read")]).toEqual([1, "DENY"]);
  });
});

/* — a request of the wrong shape is refused, before the cache and the transport ----- */

/*
 * An identifier is a string. A request whose resource type, action or resource id is anything else
 * is a caller's programming error, and it is refused where it enters — before the cache is read and
 * before the transport is called — instead of being sent, answered, and discarded on the way back.
 *
 * Every case asserts two things: the RangeError that names the field, and that the transport was
 * never asked. The second is the harm the refusal removes: a malformed request used to reach the
 * backend on every call and have its answer thrown away.
 */
describe("decide() refuses a request whose identifiers are not strings", () => {
  function counting() {
    let calls = 0;
    const transport: AuthorizationTransport = {
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async (_app, request) => {
        calls += 1;
        return decisionSet(
          request.actions.flatMap((action) =>
            request.resourceIds.map((resourceId) => ({ action, resourceId, effect: "PERMIT" as const })),
          ),
        );
      },
    };
    return { transport, calls: () => calls };
  }

  it.each([
    ["a numeric resource id", { resourceType: "orders", actions: ["read"], resourceIds: [42] }, "resourceIds[0] must be a string, received number"],
    ["a numeric action", { resourceType: "orders", actions: [7], resourceIds: ["r-1"] }, "actions[0] must be a string, received number"],
    ["a numeric resource type", { resourceType: 1, actions: ["read"], resourceIds: ["r-1"] }, "resourceType must be a string, received number"],
    ["a boxed string id", { resourceType: "orders", actions: ["read"], resourceIds: [new String("r-1")] }, "resourceIds[0] must be a string, received an object"],
    ["a null resource id", { resourceType: "orders", actions: ["read"], resourceIds: [null] }, "resourceIds[0] must be a string, received null"],
    ["the second id wrong", { resourceType: "orders", actions: ["read"], resourceIds: ["r-1", 2] }, "resourceIds[1] must be a string, received number"],
    ["ids that are not an array", { resourceType: "orders", actions: ["read"], resourceIds: null }, "resourceIds must be an array, received null"],
    ["a request that is not an object", null, "the request must be an object, received null"],
  ] as const)("%s: refused with a RangeError that names the field, and the transport is never asked", async (...row) => {
    const [, request, message] = row;
    const { transport, calls } = counting();
    const s = session(transport);
    await s.start();

    const result = await outcome(s.decide(request as unknown as DecisionRequest));

    expect([result, calls()]).toEqual([{ rejected: `RangeError: decide(): ${message}` }, 0]);
  });

  it("a well-formed request still resolves and asks the transport once", async () => {
    const { transport, calls } = counting();
    const s = session(transport);
    await s.start();

    const decided = await s.decide(REQUEST);

    expect([decisionFor(decided, "read", "r-1"), calls()]).toEqual(["PERMIT", 1]);
  });

  it("a session that answers nothing does not judge the request: IDLE and closed keep returning []", async () => {
    const { transport, calls } = counting();
    const idle = session(transport);
    const closed = session(transport);
    await closed.start();
    closed.close();
    const malformed = { resourceType: "orders", actions: ["read"], resourceIds: [42] } as unknown as DecisionRequest;

    const results = [await outcome(idle.decide(malformed)), await outcome(closed.decide(malformed))];

    expect([results, calls()]).toEqual([[{ value: [] }, { value: [] }], 0]);
  });

  it("a session without access to the app does not judge the request either", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => {
        throw new AuthorizationTransportError("NO_ACCESS_IN_APP");
      },
      fetchDecisions: async () => {
        calls += 1;
        return decisionSet([]);
      },
    });
    await s.start();
    const malformed = { resourceType: "orders", actions: ["read"], resourceIds: [42] } as unknown as DecisionRequest;

    const result = await outcome(s.decide(malformed));

    expect([s.getState().status, result, calls]).toEqual(["NO_ACCESS_IN_APP", { value: [] }, 0]);
  });
});

/* — an empty menu and an unusable menu are different screens --------------------- */

/*
 * `READY` with an empty menu has to keep meaning "you may enter and may do nothing". A menu that
 * arrives with entries and keeps none of them is not that answer: it is an answer that could not be
 * used, and it is `UNAVAILABLE`. A menu whose entries are all read, some naming their action and the
 * rest naming none, is `READY` with the ones that name one.
 */
describe("an empty menu and an unusable menu are different screens", () => {
  function withEntries(entries: readonly unknown[]): AuthorizationTransport {
    return {
      fetchPermissions: async () => ({ app: APP, permissions: entries }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    };
  }
  const NAMING_NONE = [null, 1, "read", [], {}, { effect: "PERMIT" }, { action: 5 }, { action: null }, true, { action: { id: 1 } }];

  it("permissions: [] is READY with an empty menu", async () => {
    const s = session(withEntries([]));
    await s.start();
    expect(s.getState()).toEqual({ status: "READY", permissions: [] });
  });

  it("ten entries none of which names its action is UNAVAILABLE, not READY with an empty menu", async () => {
    const s = session(withEntries(NAMING_NONE));
    const started = await outcome(s.start());
    expect([started, s.getState()]).toEqual([{ value: undefined }, { status: "UNAVAILABLE" }]);
  });

  it("ten entries, three of which name their action, is READY with exactly those three", async () => {
    const readable = [
      { action: "read", effect: "PERMIT" },
      { action: "write", effect: "DENY" },
      { action: "approve", effect: "CONDITIONAL" },
    ];
    const s = session(withEntries([...NAMING_NONE.slice(0, 7), ...readable]));
    const started = await outcome(s.start());
    expect([started, s.getState()]).toEqual([{ value: undefined }, { status: "READY", permissions: readable }]);
  });

  /*
   * A numeric action code comes from a BACKEND, so it is discarded, not refused: `start()` never
   * rejects over it. Whether the subject sees a screen that says so depends on what else arrived.
   */
  it("a menu of numeric action codes only is UNAVAILABLE, and start() does not reject", async () => {
    const s = session(withEntries([{ action: 101, effect: "PERMIT" }, { action: 102, effect: "PERMIT" }]));
    const started = await outcome(s.start());
    expect([started, s.getState()]).toEqual([{ value: undefined }, { status: "UNAVAILABLE" }]);
  });

  it("a menu mixing numeric codes and string actions is READY with the string ones", async () => {
    const s = session(withEntries([{ action: 101, effect: "PERMIT" }, { action: "read", effect: "PERMIT" }]));
    await s.start();
    expect(s.getState()).toEqual({ status: "READY", permissions: [{ action: "read", effect: "PERMIT" }] });
  });
});

/* — the identity of a menu entry is its action ------------------------------------ */

/*
 * `PermissionEntry` declares `action`, `effect` and `dependsOn`, and `permissionFor` looks an entry
 * up by `action` alone. So the menu holds one entry per action: two entries that differ only in a
 * field the type does not declare — a resource type, say — are the same entry to this package, and
 * they collapse the way a duplicated decision pair does.
 */
describe("the identity of a menu entry is its action", () => {
  function withEntries(entries: readonly unknown[]): AuthorizationTransport {
    return {
      fetchPermissions: async () => ({ app: APP, permissions: entries }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    };
  }
  async function menuOf(entries: readonly unknown[]) {
    const s = session(withEntries(entries));
    await s.start();
    const state = s.getState();
    return state.status === "READY" ? state.permissions : state.status;
  }

  it.each([
    ["orders PERMIT, invoices DENY", [{ action: "read", resourceType: "orders", effect: "PERMIT" }, { action: "read", resourceType: "invoices", effect: "DENY" }]],
    ["invoices DENY, orders PERMIT", [{ action: "read", resourceType: "invoices", effect: "DENY" }, { action: "read", resourceType: "orders", effect: "PERMIT" }]],
  ] as const)("%s: one entry for `read`, and it is DENY", async (...row) => {
    const [, entries] = row;
    const permissions = await menuOf(entries);
    expect([Array.isArray(permissions) ? permissions.length : permissions, permissionFor(permissions as never, "read")]).toEqual([1, "DENY"]);
  });

  it("two PERMIT entries for different resource types are one entry: the second is not kept", async () => {
    const permissions = await menuOf([
      { action: "read", resourceType: "orders", effect: "PERMIT" },
      { action: "read", resourceType: "invoices", effect: "PERMIT" },
    ]);
    expect(permissions).toEqual([{ action: "read", resourceType: "orders", effect: "PERMIT" }]);
  });

  it("on a tie the FIRST entry is kept whole, dependsOn included", async () => {
    const first = { action: "approve", effect: "CONDITIONAL", dependsOn: ["amount"] };
    const second = { action: "approve", effect: "CONDITIONAL", dependsOn: ["region"] };
    expect([await menuOf([first, second]), await menuOf([second, first])]).toEqual([[first], [second]]);
  });
});

/* — the cache is keyed by the resource type the call asked about ------------------ */

/*
 * The request is the consumer's object, and nothing stops it changing while its answers are in
 * flight — a component that reuses one request object for the next question does exactly that. The
 * answers belong to the resource type that was asked, and that is the type they are cached under.
 */
describe("the cache is keyed by the resource type the call asked about", () => {
  it("a request object changed while its call is in flight does not file one type's answers under another", async () => {
    const ordersAnswer = deferred<void>();
    let calls = 0;
    const effects: Readonly<Record<string, "PERMIT" | "DENY">> = { orders: "PERMIT", invoices: "DENY" };
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async (_app, request) => {
        calls += 1;
        const effect = effects[request.resourceType] ?? "DENY";
        if (request.resourceType === "orders") {
          await ordersAnswer.promise;
        }
        return decisionSet(request.resourceIds.map((resourceId) => ({ action: "read", resourceId, effect })));
      },
    });
    await s.start();

    const reused = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1"] };
    const inFlight = s.decide(reused);
    reused.resourceType = "invoices";
    ordersAnswer.resolve();
    const asked = await inFlight;
    const later = await s.decide({ resourceType: "invoices", actions: ["read"], resourceIds: ["r-1"] });

    expect([decisionFor(asked, "read", "r-1"), decisionFor(later, "read", "r-1"), calls]).toEqual([
      "PERMIT",
      "DENY",
      2,
    ]);
  });

  it("a resource type that answers differently on every read is read once: sent and cached as the same type", async () => {
    const sent: string[] = [];
    let calls = 0;
    const effects: Readonly<Record<string, "PERMIT" | "DENY">> = { orders: "PERMIT", invoices: "DENY" };
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async (_app, request) => {
        calls += 1;
        sent.push(request.resourceType);
        const effect = effects[request.resourceType] ?? "DENY";
        return decisionSet(request.resourceIds.map((resourceId) => ({ action: "read", resourceId, effect })));
      },
    });
    await s.start();
    let reads = 0;
    const shifting = {
      get resourceType() {
        reads += 1;
        return reads % 2 === 1 ? "orders" : "invoices";
      },
      actions: ["read"],
      resourceIds: ["r-1"],
    };

    const asked = await s.decide(shifting);
    const later = await s.decide({ resourceType: "invoices", actions: ["read"], resourceIds: ["r-1"] });

    expect([reads, decisionFor(asked, "read", "r-1"), decisionFor(later, "read", "r-1"), sent, calls]).toEqual([
      1,
      "PERMIT",
      "DENY",
      ["orders", "invoices"],
      2,
    ]);
  });
});

/* — what is used is what was checked ------------------------------------------------ */

/*
 * A value that reaches this package from code that can still reach it afterwards — a request the
 * consumer passed, an answer its transport returned, a decision handed back to the caller — is read
 * once, where it is checked, and what the package does from then on uses that copy. Each block below
 * changes the outside object after the check and asserts that nothing the package answers moves.
 */
describe("what is used is what was checked", () => {
  it("the request's arrays are read when the call is made: changing them while it is in flight changes nothing it asks", async () => {
    const sent: (readonly string[])[] = [];
    const s = session({
      fetchPermissions: async () => menu(["read", "write"]),
      fetchDecisions: async (_app, request) => {
        await Promise.resolve();
        sent.push([...request.actions]);
        return decisionSet(request.actions.map((action) => ({ action, resourceId: "r-1", effect: "PERMIT" as const })));
      },
    });
    await s.start();
    const actions = ["read"];
    const decided = s.decide({ resourceType: "orders", actions, resourceIds: ["r-1"] });
    actions[0] = "write";

    const result = await decided;

    expect([sent, decisionFor(result, "read", "r-1")]).toEqual([[["read"]], "PERMIT"]);
  });

  it("an answer the transport rewrites after returning it does not change what the cache answers", async () => {
    const returned: { action: string; resourceId: string; effect: string }[] = [];
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        calls += 1;
        const decision = { action: "read", resourceId: "r-1", effect: "DENY" };
        returned.push(decision);
        return raw(decision);
      },
    });
    await s.start();
    const first = await s.decide(REQUEST);
    for (const decision of returned) {
      decision.effect = "PERMIT";
    }

    const later = await s.decide(REQUEST);

    expect([decisionFor(first, "read", "r-1"), decisionFor(later, "read", "r-1"), calls]).toEqual(["DENY", "DENY", 1]);
  });

  it("what a caller writes into the decisions it received does not change a later answer", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        calls += 1;
        return decisionSet([{ action: "read", resourceId: "r-1", effect: "DENY" }]);
      },
    });
    await s.start();
    const cold = await s.decide(REQUEST);
    for (const decision of cold) {
      (decision as { effect: string }).effect = "PERMIT";
    }
    const warm = await s.decide(REQUEST);
    const warmSaid = decisionFor(warm, "read", "r-1");
    for (const decision of warm) {
      (decision as { effect: string }).effect = "PERMIT";
    }

    const later = await s.decide(REQUEST);

    expect([warmSaid, decisionFor(later, "read", "r-1"), calls]).toEqual(["DENY", "DENY", 1]);
  });

  it("a menu entry the transport rewrites after returning it does not change the state", async () => {
    const entries = [{ action: "delete", effect: "DENY" }];
    const s = session({
      fetchPermissions: async () => ({ app: APP, permissions: entries }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });
    await s.start();
    for (const entry of entries) {
      entry.effect = "PERMIT";
    }

    const state = s.getState();

    expect(state.status === "READY" ? permissionFor(state.permissions, "delete") : state.status).toBe("DENY");
  });

  it("an answer whose fields are inherited is read like one whose fields are its own", async () => {
    class Entry {
      get action() {
        return "read";
      }
      get effect() {
        return "PERMIT";
      }
    }
    class Answer extends Entry {
      get resourceId() {
        return "r-1";
      }
    }
    const s = session({
      fetchPermissions: async () => ({ app: APP, permissions: [new Entry()] }) as unknown as PermissionMenu,
      fetchDecisions: async () => raw(new Answer()),
    });
    await s.start();
    const state = s.getState();

    const decided = await s.decide(REQUEST);

    expect([
      state.status === "READY" ? permissionFor(state.permissions, "read") : state.status,
      decisionFor(decided, "read", "r-1"),
    ]).toEqual(["PERMIT", "PERMIT"]);
  });
});

/* — a field named __proto__ is a field ------------------------------------------------ */

/*
 * `JSON.parse`, and so `response.json()`, turns a key named `__proto__` into an ordinary field of the
 * parsed object: the element does not inherit what that field holds. The answers below are parsed
 * from the text a backend sends, and each asserts that the element is read as the fields it has.
 */
describe("a field named __proto__ in an answer is a field like any other", () => {
  function parsed(menuText: string, decisionsText = `{"app":"${APP}","decisions":[]}`): AuthorizationTransport {
    return {
      fetchPermissions: async () => JSON.parse(menuText) as PermissionMenu,
      fetchDecisions: async () => JSON.parse(decisionsText) as DecisionSet,
    };
  }

  it("a menu whose only entry names no action of its own is UNAVAILABLE", async () => {
    const s = session(parsed(`{"app":"${APP}","permissions":[{"__proto__":{"action":"delete","effect":"PERMIT"}}]}`));
    await s.start();
    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });
  });

  it("a menu entry with no effect of its own reads DENY", async () => {
    const s = session(parsed(`{"app":"${APP}","permissions":[{"action":"delete","__proto__":{"effect":"PERMIT"}}]}`));
    await s.start();
    const state = s.getState();
    expect(state.status === "READY" ? permissionFor(state.permissions, "delete") : state.status).toBe("DENY");
  });

  it("an answer with no effect of its own still outranks a PERMIT for the same pair", async () => {
    const s = session(
      parsed(
        JSON.stringify(menu(["read"])),
        `{"app":"${APP}","decisions":[{"action":"read","resourceId":"r-1","effect":"PERMIT"},{"action":"read","resourceId":"r-1","__proto__":{"effect":"PERMIT"}}]}`,
      ),
    );
    await s.start();
    const decided = await s.decide(REQUEST);
    expect(decisionFor(decided, "read", "r-1")).toBe("DENY");
  });
});


/* — what a copy keeps of the answer it copies ----------------------------------------------- */

/*
 * Each case below is something a consumer with a hand-written transport could do before any copy
 * existed, and still can: the copy carries the element's prototype and its own properties, and reads
 * the fields this package judges once.
 */
describe("what a copy keeps of the answer it copies", () => {
  function lazyThrowing<T extends object>(value: T): T {
    return Object.defineProperty(value, "lazy", {
      get() {
        throw new Error("not loaded");
      },
      enumerable: true,
    });
  }

  it("a menu entry whose extra field throws when read leaves the session READY with that entry", async () => {
    const s = session({
      fetchPermissions: async () =>
        ({ app: APP, permissions: [lazyThrowing({ action: "read", effect: "PERMIT" })] }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    const started = await outcome(s.start());
    const state = s.getState();

    expect([started, state.status === "READY" ? permissionFor(state.permissions, "read") : state.status]).toEqual([
      { value: undefined },
      "PERMIT",
    ]);
  });

  it("a decision whose extra field throws when read is answered, and then answered from the cache", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        calls += 1;
        return raw(lazyThrowing({ action: "read", resourceId: "r-1", effect: "PERMIT" }));
      },
    });
    await s.start();

    const cold = await outcome(s.decide(REQUEST));
    const warm = await outcome(s.decide(REQUEST));

    expect([
      "value" in cold ? decisionFor(cold.value, "read", "r-1") : cold.rejected,
      "value" in warm ? decisionFor(warm.value, "read", "r-1") : warm.rejected,
      calls,
    ]).toEqual(["PERMIT", "PERMIT", 1]);
  });

  it("getters and methods that read the object's own fields answer on what is handed back", async () => {
    class Entry {
      constructor(
        readonly action: string,
        readonly effect: string,
      ) {}
      get label(): string {
        return `label:${this.action}`;
      }
    }
    class Answer extends Entry {
      readonly resourceId = "r-1";
      describe(): string {
        return `${this.action}/${this.resourceId}`;
      }
    }
    const s = session({
      fetchPermissions: async () => ({ app: APP, permissions: [new Entry("read", "PERMIT")] }) as unknown as PermissionMenu,
      fetchDecisions: async () => raw(new Answer("read", "PERMIT")),
    });
    await s.start();
    const state = s.getState();
    const entry = state.status === "READY" ? state.permissions[0] : undefined;

    const cold = (await s.decide(REQUEST))[0];
    const warm = (await s.decide(REQUEST))[0];

    expect([
      entry instanceof Entry,
      (entry as Entry | undefined)?.label,
      cold instanceof Answer && warm instanceof Answer,
      cold instanceof Answer ? cold.describe() : "not an Answer",
      warm instanceof Answer ? warm.describe() : "not an Answer",
    ]).toEqual([true, "label:read", true, "read/r-1", "read/r-1"]);
  });

  it("a field keyed by a symbol, and one that is not enumerable, are carried on what is handed back", async () => {
    const origin = Symbol("origin");
    const answer = Object.defineProperty({ action: "read", resourceId: "r-1", effect: "PERMIT", [origin]: "server-a" }, "source", {
      value: "pdp",
      enumerable: false,
    });
    const s = session({ fetchPermissions: async () => menu(["read"]), fetchDecisions: async () => raw(answer) });
    await s.start();

    const cold = ((await s.decide(REQUEST))[0] ?? {}) as unknown as Record<PropertyKey, unknown>;
    const warm = ((await s.decide(REQUEST))[0] ?? {}) as unknown as Record<PropertyKey, unknown>;

    expect([cold[origin], cold.source, warm[origin], warm.source]).toEqual(["server-a", "pdp", "server-a", "pdp"]);
  });

  it("a field named __proto__ is a field of what is handed back, and supplies none of its other fields", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        JSON.parse(
          `{"app":"${APP}","decisions":[{"action":"read","resourceId":"r-1","effect":"PERMIT","__proto__":{"label":"not sent"}}]}`,
        ) as DecisionSet,
    });
    await s.start();

    const cold = ((await s.decide(REQUEST))[0] ?? {}) as unknown as Record<string, unknown>;
    const warm = ((await s.decide(REQUEST))[0] ?? {}) as unknown as Record<string, unknown>;

    expect(
      [cold, warm].map((d) => [
        Object.getPrototypeOf(d) === Object.prototype,
        d.label,
        Object.getOwnPropertyDescriptor(d, "__proto__")?.value,
      ]),
    ).toEqual([
      [true, undefined, { label: "not sent" }],
      [true, undefined, { label: "not sent" }],
    ]);
  });

  it("a frozen menu entry is frozen in the state", async () => {
    const s = session({
      fetchPermissions: async () =>
        ({ app: APP, permissions: [Object.freeze({ action: "read", effect: "PERMIT" })] }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });
    await s.start();
    const state = s.getState();

    expect(state.status === "READY" ? Object.isFrozen(state.permissions[0]) : state.status).toBe(true);
  });

  it.each([
    ["sealed", (entry: object) => Object.seal(entry), [false, true, false]],
    ["not extensible", (entry: object) => Object.preventExtensions(entry), [false, false, false]],
    ["extensible", (entry: object) => entry, [false, false, true]],
  ] as const)("a menu entry that is %s is exactly that in the state", async (_n, make, expected) => {
    const s = session({
      fetchPermissions: async () =>
        ({ app: APP, permissions: [make({ action: "read", effect: "PERMIT" })] }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });
    await s.start();
    const state = s.getState();
    const entry = state.status === "READY" ? state.permissions[0] : undefined;

    expect(entry === undefined ? state.status : [Object.isFrozen(entry), Object.isSealed(entry), Object.isExtensible(entry)]).toEqual(expected);
  });

  it("a prototype changed after the answer was read turns no DENY into a PERMIT, on screen or from the cache", async () => {
    class Entry {
      constructor(readonly action: string) {}
    }
    class Answer {
      constructor(
        readonly action: string,
        readonly resourceId: string,
      ) {}
    }
    let calls = 0;
    const s = session({
      fetchPermissions: async () => ({ app: APP, permissions: [new Entry("delete")] }) as unknown as PermissionMenu,
      fetchDecisions: async () => {
        calls += 1;
        return raw(new Answer("read", "r-1"));
      },
    });
    await s.start();
    await s.decide(REQUEST);

    Object.assign(Entry.prototype, { effect: "PERMIT" });
    Object.assign(Answer.prototype, { effect: "PERMIT" });
    const state = s.getState();
    const later = await s.decide(REQUEST);

    expect([
      state.status === "READY" ? permissionFor(state.permissions, "delete") : state.status,
      decisionFor(later, "read", "r-1"),
      calls,
    ]).toEqual(["DENY", "DENY", 1]);
  });

  it("an answer whose effect throws when read reads DENY, and still outranks a PERMIT for the same pair", async () => {
    const unreadable = Object.defineProperty({ action: "read", resourceId: "r-1" }, "effect", {
      get() {
        throw new Error("not loaded");
      },
      enumerable: true,
    });
    const s = session({ fetchPermissions: async () => menu(["read"]), fetchDecisions: async () => raw(PERMIT_R1, unreadable) });
    await s.start();

    const decided = await outcome(s.decide(REQUEST));

    expect("value" in decided ? decisionFor(decided.value, "read", "r-1") : decided.rejected).toBe("DENY");
  });

  it("an entry that cannot be read at all makes the menu UNAVAILABLE, and start() still resolves", async () => {
    const revoked = Proxy.revocable({ action: "delete", effect: "PERMIT" }, {});
    revoked.revoke();
    const s = session({
      fetchPermissions: async () =>
        ({ app: APP, permissions: [revoked.proxy, { action: "read", effect: "PERMIT" }] }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    const started = await outcome(s.start());

    expect([started, s.getState()]).toEqual([{ value: undefined }, { status: "UNAVAILABLE" }]);
  });
});

/* — an element that cannot be read may be a DENY ------------------------------------------------ */

/*
 * Each kind below is a DENY that plain reads still see — `element.action`, `element.effect` — or whose
 * pair cannot be read at all, handed back beside a readable PERMIT for the same pair. Discarding it would
 * leave the PERMIT to answer alone, so the menu is not used and the call answers no pair.
 */
describe("an element that cannot be read may be a DENY, and no PERMIT answers alone beside it", () => {
  function fail(): never {
    throw new Error("not loaded");
  }
  /** What a settled call answers for one pair, or what it rejected with. */
  function answerFor(settled: { value: readonly Decision[] } | { rejected: string }, resourceId: string): string {
    return "value" in settled ? decisionFor(settled.value, "read", resourceId) : settled.rejected;
  }
  const kinds: readonly (readonly [string, (element: Record<string, unknown>) => unknown])[] = [
    ["a revoked Proxy", (element) => {
      const revoked = Proxy.revocable(element, {});
      revoked.revoke();
      return revoked.proxy;
    }],
    ["a Proxy whose keys cannot be listed", (element) => new Proxy(element, { ownKeys: fail })],
    ["a Proxy whose prototype cannot be read", (element) => new Proxy(element, { getPrototypeOf: fail })],
    ["an element whose action throws when read", (element) =>
      Object.defineProperty({ ...element }, "action", { get: fail, enumerable: true })],
    ["a function carrying its fields", (element) => Object.assign(function element() {}, element)],
  ];

  it.each(kinds)("a menu with a DENY entry that is %s, and a PERMIT for the same action, is UNAVAILABLE", async (_kind, make) => {
    for (const order of ["DENY first", "PERMIT first"]) {
      const deny = make({ action: "delete", effect: "DENY" });
      const permit = { action: "delete", effect: "PERMIT" };
      const s = session({
        fetchPermissions: async () =>
          ({ app: APP, permissions: order === "DENY first" ? [deny, permit] : [permit, deny] }) as unknown as PermissionMenu,
        fetchDecisions: async () => decisionSet([]),
      });

      const started = await outcome(s.start());
      const state = s.getState();

      expect([
        order,
        "rejected" in started ? started.rejected : state.status === "READY" ? permissionFor(state.permissions, "delete") : state.status,
      ]).toEqual([order, "UNAVAILABLE"]);
    }
  });

  it.each(kinds)("an answer with a DENY element that is %s, and a PERMIT for the same pair, answers DENY and caches nothing", async (_kind, make) => {
    for (const order of ["DENY first", "PERMIT first"]) {
      let calls = 0;
      const s = session({
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async () => {
          calls += 1;
          const deny = make({ action: "read", resourceId: "r-1", effect: "DENY" });
          return raw(...(order === "DENY first" ? [deny, PERMIT_R1] : [PERMIT_R1, deny]));
        },
      });
      await s.start();

      const cold = await outcome(s.decide(REQUEST));
      const warm = await outcome(s.decide(REQUEST));

      expect([order, answerFor(cold, "r-1"), answerFor(warm, "r-1"), calls]).toEqual([order, "DENY", "DENY", 2]);
    }
  });

  it("a DENY element whose read out of the list throws, beside a PERMIT for the same pair, answers DENY", async () => {
    const list = [{ action: "read", resourceId: "r-1", effect: "DENY" }, PERMIT_R1];
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () =>
        ({
          app: APP,
          decisions: new Proxy(list, { get: (target, key, receiver) => (key === "0" ? fail() : Reflect.get(target, key, receiver)) }),
        }) as unknown as DecisionSet,
    });
    await s.start();

    expect(answerFor(await outcome(s.decide(REQUEST)), "r-1")).toBe("DENY");
  });

  it("an element that cannot be read in one chunk leaves a PERMIT from another chunk unanswered too", async () => {
    const revoked = Proxy.revocable({ action: "read", resourceId: "r-2", effect: "DENY" }, {});
    revoked.revoke();
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) =>
          request.resourceIds[0] === "r-1"
            ? raw(PERMIT_R1, revoked.proxy)
            : raw({ action: "read", resourceId: "r-2", effect: "PERMIT" }),
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();

    const decided = await outcome(s.decide({ ...REQUEST, resourceIds: ["r-1", "r-2"] }));

    expect([answerFor(decided, "r-1"), answerFor(decided, "r-2")]).toEqual(["DENY", "DENY"]);
  });

  it("an element whose effect throws when read names its pair: it reads DENY, and the other pairs still answer", async () => {
    const noEffect = Object.defineProperty({ action: "read", resourceId: "r-1" }, "effect", { get: fail, enumerable: true });
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => raw(noEffect, { action: "read", resourceId: "r-2", effect: "PERMIT" }),
    });
    await s.start();

    const decided = await outcome(s.decide({ ...REQUEST, resourceIds: ["r-1", "r-2"] }));

    expect([answerFor(decided, "r-1"), answerFor(decided, "r-2")]).toEqual(["DENY", "PERMIT"]);
  });

  it("a menu entry whose effect throws when read names its action: it reads DENY, and the menu is READY", async () => {
    const noEffect = Object.defineProperty({ action: "delete" }, "effect", { get: fail, enumerable: true });
    const s = session({
      fetchPermissions: async () =>
        ({ app: APP, permissions: [noEffect, { action: "read", effect: "PERMIT" }] }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    const started = await outcome(s.start());
    const state = s.getState();

    expect(
      "rejected" in started
        ? started.rejected
        : state.status === "READY"
          ? [permissionFor(state.permissions, "delete"), permissionFor(state.permissions, "read")]
          : state.status,
    ).toEqual(["DENY", "PERMIT"]);
  });
});

/* — the envelope of an answer is read once ----------------------------------------------------- */

/*
 * The object around the list — `{ app, permissions }` or `{ app, decisions }` — is judged on one read
 * of it, and the list it judged is the list it uses. `sequenced` answers each read of one field with
 * the next value, so a second read would see something the check never saw.
 */
describe("the envelope of an answer is read once", () => {
  function sequenced(base: Record<string, unknown>, field: string, values: readonly unknown[]): unknown {
    let reads = 0;
    return Object.defineProperty({ ...base }, field, {
      get() {
        const value = values[Math.min(reads, values.length - 1)];
        reads += 1;
        return value;
      },
      enumerable: true,
    });
  }
  const UNREADABLE = [{ nothing: "readable" }];

  it.each([
    ["unreadable, then an empty list", [UNREADABLE, []]],
    ["unreadable, then a readable entry", [UNREADABLE, [{ action: "read", effect: "PERMIT" }]]],
  ])("a menu list that reads %s is judged on its first read: UNAVAILABLE", async (_name, values) => {
    const s = session({
      fetchPermissions: async () => sequenced({ app: APP }, "permissions", values) as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    await s.start();

    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });
  });

  it("a menu whose list is an object with a length, not an array, is UNAVAILABLE", async () => {
    const s = session({
      fetchPermissions: async () => ({ app: APP, permissions: { length: 0 } }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    await s.start();

    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });
  });

  it("a decisions list that is an object shaped like an array is not read", async () => {
    const arrayLike = { app: APP, decisions: { length: 1, 0: PERMIT_R1 } };
    const s = session({ fetchPermissions: async () => menu(["read"]), fetchDecisions: async () => arrayLike as unknown as DecisionSet });
    await s.start();

    const decided = await outcome(s.decide(REQUEST));

    expect("value" in decided ? decisionFor(decided.value, "read", "r-1") : decided.rejected).toBe("DENY");
  });

  it("an answer that is a function is not an answer, whatever fields it carries", async () => {
    const menuFn = Object.assign(() => undefined, { app: APP, permissions: [{ action: "read", effect: "PERMIT" }] });
    const decisionsFn = Object.assign(() => undefined, { app: APP, decisions: [PERMIT_R1] });
    const s = session({
      fetchPermissions: async () => menuFn as unknown as PermissionMenu,
      fetchDecisions: async () => decisionsFn as unknown as DecisionSet,
    });
    await s.start();
    const state = s.getState();
    const decided = await outcome(s.decide(REQUEST));

    expect([state, "value" in decided ? decisionFor(decided.value, "read", "r-1") : decided.rejected]).toEqual([
      { status: "UNAVAILABLE" },
      "DENY",
    ]);
  });

  it("a menu whose envelope throws when read is UNAVAILABLE", async () => {
    const envelope = Object.defineProperty({}, "app", {
      get() {
        throw new Error("not loaded");
      },
    });
    const s = session({ fetchPermissions: async () => envelope as PermissionMenu, fetchDecisions: async () => decisionSet([]) });

    const started = await outcome(s.start());

    expect([started, s.getState()]).toEqual([{ value: undefined }, { status: "UNAVAILABLE" }]);
  });

  function twoChunks(first: unknown): AuthorizationTransport {
    return {
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async (_app, request) =>
        request.resourceIds[0] === "r-1"
          ? (first as DecisionSet)
          : decisionSet([{ action: "read", resourceId: "r-2", effect: "PERMIT" }]),
    };
  }
  const BOTH: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] };

  it("a decisions list that is no longer a list on a second read does not reject the call", async () => {
    const s = session(twoChunks(sequenced({ app: APP }, "decisions", [[PERMIT_R1], { not: "a list" }])), { maxPairsPerRequest: 1 });
    await s.start();

    const decided = await outcome(s.decide(BOTH));

    expect(
      "value" in decided ? [decisionFor(decided.value, "read", "r-1"), decisionFor(decided.value, "read", "r-2")] : decided.rejected,
    ).toEqual(["PERMIT", "PERMIT"]);
  });

  it("a PERMIT that was not in the list the check read is not returned", async () => {
    const s = session(twoChunks(sequenced({ app: APP }, "decisions", [[], new Set([PERMIT_R1])])), { maxPairsPerRequest: 1 });
    await s.start();

    const decided = await s.decide(BOTH);

    expect([decisionFor(decided, "read", "r-1"), decisionFor(decided, "read", "r-2")]).toEqual(["DENY", "PERMIT"]);
  });

  it("a decisions envelope that throws when read leaves every pair of the call DENY, the chunk beside it included", async () => {
    const envelope = Object.defineProperty({ app: APP }, "decisions", {
      get() {
        throw new Error("not loaded");
      },
    });
    const s = session(twoChunks(envelope), { maxPairsPerRequest: 1 });
    await s.start();

    const decided = await outcome(s.decide(BOTH));

    expect(
      "value" in decided ? [decisionFor(decided.value, "read", "r-1"), decisionFor(decided.value, "read", "r-2")] : decided.rejected,
    ).toEqual(["DENY", "DENY"]);
  });
});

/* — an empty request and the pair cap ---------------------------------------------------------- */

describe("an empty request to a session whose pair cap is unusable", () => {
  it.each([0, 1.5, undefined])("is refused with a RangeError, like a request that asks for a pair (cap %s)", async (cap) => {
    const s = createAuthorizationSession({
      app: APP,
      transport: { fetchPermissions: async () => menu([]), fetchDecisions: async () => decisionSet([]) },
      maxPairsPerRequest: cap as number,
    });
    await s.start();

    const empty = await outcome(s.decide({ resourceType: "orders", actions: [], resourceIds: [] }));
    const one = await outcome(s.decide(REQUEST));

    expect([empty, one].map((o) => ("rejected" in o ? o.rejected.split(":")[0] : "resolved"))).toEqual(["RangeError", "RangeError"]);
  });
});

/* — every field this package judges is read once --------------------------------------------- */

/*
 * One case per judged field: the element that carries the DENY answers it on the first read of that
 * field and something else on every later read, beside a PERMIT for the same pair or action. Read
 * once, the element is the DENY it said it was, on screen and from the cache.
 */
describe("every field this package judges is read once", () => {
  function answeringOnceThen<T extends object>(value: T, field: string, first: unknown, later: unknown): T {
    let reads = 0;
    return Object.defineProperty(value, field, {
      get() {
        reads += 1;
        return reads === 1 ? first : later;
      },
      enumerable: true,
      configurable: true,
    });
  }

  it.each([
    ["effect", "DENY", "PERMIT"],
    ["action", "read", "write"],
    ["resourceId", "r-1", "r-9"],
  ])("a decision whose %s answers differently after its first read is the DENY it first said", async (field, first, later) => {
    const deny = answeringOnceThen({ action: "read", resourceId: "r-1", effect: "DENY" }, field, first, later);
    const s = session({ fetchPermissions: async () => menu(["read"]), fetchDecisions: async () => raw(deny, PERMIT_R1) });
    await s.start();

    const cold = await outcome(s.decide(REQUEST));
    const warm = await outcome(s.decide(REQUEST));

    expect([cold, warm].map((o) => ("value" in o ? decisionFor(o.value, "read", "r-1") : o.rejected))).toEqual([
      "DENY",
      "DENY",
    ]);
  });

  it.each([
    ["effect", "DENY", "PERMIT"],
    ["action", "delete", "write"],
  ])("a menu entry whose %s answers differently after its first read is the DENY it first said", async (field, first, later) => {
    const deny = answeringOnceThen({ action: "delete", effect: "DENY" }, field, first, later);
    const s = session({
      fetchPermissions: async () =>
        ({ app: APP, permissions: [deny, { action: "delete", effect: "PERMIT" }] }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    await outcome(s.start());
    const state = s.getState();

    expect(state.status === "READY" ? permissionFor(state.permissions, "delete") : state.status).toBe("DENY");
  });
});

/*
 * A view can answer a field's descriptor with one value — or with none — and a read of the field with
 * another. None of these throws, and `element.action`, `element.resourceId` and `element.effect` read
 * the DENY; the field is what that read gives.
 */
describe("a field is what reading it gives, whatever its descriptor says", () => {
  const views: readonly (readonly [string, (element: Record<string, unknown>) => unknown])[] = [
    ["answers every descriptor with { enumerable, configurable } and no value", (element) =>
      new Proxy({}, {
        get: (_target, key) => element[key as string],
        has: (_target, key) => key in element,
        ownKeys: () => Reflect.ownKeys(element),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      })],
    ["answers its descriptors from an empty target", (element) =>
      new Proxy({} as Record<string, unknown>, {
        get: (_target, key) => element[key as string],
        ownKeys: () => Reflect.ownKeys(element),
        getOwnPropertyDescriptor: (target, key) => ({ value: target[key as string], writable: true, enumerable: true, configurable: true }),
      })],
    ["keeps defaults on its target and answers reads from the element", (element) =>
      new Proxy({ action: "", resourceId: "", effect: "PERMIT" } as Record<string, unknown>, {
        get: (target, key) => (typeof key === "string" && key in element ? element[key] : target[key as string]),
      })],
  ];

  it.each(views)("a DENY given through a view that %s, beside a PERMIT for the same pair, answers DENY, cold and from the cache", async (_view, make) => {
    for (const order of ["DENY first", "PERMIT first"]) {
      let calls = 0;
      const s = session({
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async () => {
          calls += 1;
          const deny = make({ action: "read", resourceId: "r-1", effect: "DENY" });
          return raw(...(order === "DENY first" ? [deny, PERMIT_R1] : [PERMIT_R1, deny]));
        },
      });
      await s.start();

      const cold = await outcome(s.decide(REQUEST));
      const warm = await outcome(s.decide(REQUEST));

      expect([order, ...[cold, warm].map((o) => ("value" in o ? decisionFor(o.value, "read", "r-1") : o.rejected)), calls]).toEqual([
        order,
        "DENY",
        "DENY",
        1,
      ]);
    }
  });

  it.each(views)("a menu DENY entry given through a view that %s, beside a PERMIT for the same action, reads DENY", async (_view, make) => {
    for (const order of ["DENY first", "PERMIT first"]) {
      const deny = make({ action: "delete", effect: "DENY" });
      const permit = { action: "delete", effect: "PERMIT" };
      const s = session({
        fetchPermissions: async () =>
          ({ app: APP, permissions: order === "DENY first" ? [deny, permit] : [permit, deny] }) as unknown as PermissionMenu,
        fetchDecisions: async () => decisionSet([]),
      });

      const started = await outcome(s.start());
      const state = s.getState();

      expect([
        order,
        "rejected" in started ? started.rejected : state.status === "READY" ? permissionFor(state.permissions, "delete") : state.status,
      ]).toEqual([order, "DENY"]);
    }
  });

  it.each(views)("a PERMIT given through a view that %s answers PERMIT: the view is read, not dropped", async (_view, make) => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => raw(make({ action: "read", resourceId: "r-1", effect: "PERMIT" })),
    });
    await s.start();

    const decided = await outcome(s.decide(REQUEST));

    expect("value" in decided ? decisionFor(decided.value, "read", "r-1") : decided.rejected).toBe("PERMIT");
  });
});

describe("a listener that subscribes during the final emission of close()", () => {
  it("receives nothing: the session is already closed when it subscribes", async () => {
    const s = session(permitting(["read"]));
    await s.start();
    const heardByLate: string[] = [];
    s.subscribe((state) => {
      if (state.status === "IDLE") {
        s.subscribe((later) => heardByLate.push(later.status));
      }
    });

    s.close();

    expect(heardByLate).toEqual([]);
  });
});

/* — a position a list gains while it is read was never read ------------------------------------ */

/*
 * The list of an answer is read up to the length it had when it was read. A position it gains while it is
 * being read — through a position's own accessor, or an element's — was never read, and it may be the
 * DENY for a pair a readable element permits.
 */
describe("a position a list gains while it is read may be a DENY", () => {
  const DENY_R1 = { action: "read", resourceId: "r-1", effect: "DENY" };

  /** A list holding `first`, whose position 0 appends `appended` to the list when it is read. */
  function growingWhenRead(first: unknown, appended: unknown): unknown[] {
    const list: unknown[] = [first];
    Object.defineProperty(list, 0, {
      get() {
        list.push(appended);
        return first;
      },
      enumerable: true,
      configurable: true,
    });
    return list;
  }

  it("a menu whose list gains a DENY entry while it is read is UNAVAILABLE", async () => {
    const s = session({
      fetchPermissions: async () =>
        ({ app: APP, permissions: growingWhenRead({ action: "read", effect: "PERMIT" }, { action: "read", effect: "DENY" }) }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    await s.start();

    expect(s.getState()).toEqual({ status: "UNAVAILABLE" });
  });

  it("an answer whose list gains a DENY while it is read answers DENY and caches nothing", async () => {
    let calls = 0;
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        calls += 1;
        return { app: APP, decisions: growingWhenRead(PERMIT_R1, DENY_R1) } as unknown as DecisionSet;
      },
    });
    await s.start();

    const cold = await s.decide(REQUEST);
    const warm = await s.decide(REQUEST);

    expect([decisionFor(cold, "read", "r-1"), decisionFor(warm, "read", "r-1"), calls]).toEqual(["DENY", "DENY", 2]);
  });

  it("an element whose action appends a DENY to its own list when read answers DENY", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => {
        const list: unknown[] = [];
        list.push({
          get action() {
            list.push(DENY_R1);
            return "read";
          },
          resourceId: "r-1",
          effect: "PERMIT",
        });
        return { app: APP, decisions: list } as unknown as DecisionSet;
      },
    });
    await s.start();

    expect(decisionFor(await s.decide(REQUEST), "read", "r-1")).toBe("DENY");
  });

  it("an element of one chunk that appends a DENY to another chunk's list, already read, answers DENY", async () => {
    const first: unknown[] = [PERMIT_R1];
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) =>
          request.resourceIds[0] === "r-1"
            ? ({ app: APP, decisions: first } as unknown as DecisionSet)
            : raw({
                get action() {
                  first.push(DENY_R1);
                  return "read";
                },
                resourceId: "r-2",
                effect: "PERMIT",
              }),
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();

    const decided = await s.decide({ ...REQUEST, resourceIds: ["r-1", "r-2"] });

    expect([decisionFor(decided, "read", "r-1"), decisionFor(decided, "read", "r-2")]).toEqual(["DENY", "DENY"]);
  });

  it("a list that loses a position while it is read answers from what was read", async () => {
    const list: unknown[] = [PERMIT_R1, { action: "read", resourceId: "r-2", effect: "DENY" }];
    Object.defineProperty(list, 0, {
      get() {
        list.length = 1;
        return PERMIT_R1;
      },
      enumerable: true,
      configurable: true,
    });
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => ({ app: APP, decisions: list }) as unknown as DecisionSet,
    });
    await s.start();

    expect(decisionFor(await s.decide(REQUEST), "read", "r-1")).toBe("PERMIT");
  });
});

/* — a pair is answered by a chunk that asked for it -------------------------------------------- */

/*
 * Two chunks: with a cap of one pair, `read` over r-1 and r-2 is asked as r-1 in one call and r-2 in
 * another. A conforming backend answers each call with the pairs it was asked; these answer more.
 */
describe("a pair is answered by a chunk that asked for it", () => {
  const BOTH: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] };
  const PERMIT_R2: Decision = { action: "read", resourceId: "r-2", effect: "PERMIT" };

  function split(first: () => Promise<DecisionSet>, second: () => Promise<DecisionSet>) {
    let calls = 0;
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: (_app, request) => {
          calls += 1;
          return request.resourceIds[0] === "r-1" ? first() : second();
        },
      },
      { maxPairsPerRequest: 1 },
    );
    return { s, calls: () => calls };
  }

  it.each([
    ["rejects", () => Promise.reject(new Error("down"))],
    ["answers for another application", async () => decisionSet([{ action: "read", resourceId: "r-1", effect: "DENY" }], "app-b")],
    ["answers something that is not an answer", async () => null as unknown as DecisionSet],
  ] as const)("when the chunk that asked for a pair %s, a PERMIT for it from another chunk answers nothing, and nothing of it is cached", async (_n, failing) => {
    const { s, calls } = split(failing, async () => decisionSet([PERMIT_R2, PERMIT_R1]));
    await s.start();

    const cold = await outcome(s.decide(BOTH));
    const before = calls();
    const warm = await outcome(s.decide(REQUEST));
    const answer = (settled: typeof cold, resourceId: string) =>
      "value" in settled ? decisionFor(settled.value, "read", resourceId) : settled.rejected;

    expect([answer(cold, "r-1"), answer(cold, "r-2"), answer(warm, "r-1"), calls() - before]).toEqual([
      "DENY",
      "PERMIT",
      "DENY",
      1,
    ]);
  });

  it("a DENY for a pair from a chunk that did not ask for it makes the answer of the chunk that did more restrictive", async () => {
    const { s } = split(
      async () => decisionSet([PERMIT_R1]),
      async () => decisionSet([PERMIT_R2, { action: "read", resourceId: "r-1", effect: "DENY" }]),
    );
    await s.start();

    const decided = await outcome(s.decide(BOTH));

    expect("value" in decided ? [decisionFor(decided.value, "read", "r-1"), decisionFor(decided.value, "read", "r-2")] : decided.rejected).toEqual([
      "DENY",
      "PERMIT",
    ]);
  });

  it.each([
    ["the first", 1],
    ["the second", 2],
  ] as const)("a pair a request asks twice is answered by the chunk that answers when %s one fails", async (_n, failing) => {
    let call = 0;
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async () => {
          call += 1;
          if (call === failing) {
            throw new Error("down");
          }
          return decisionSet([PERMIT_R1]);
        },
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();

    const decided = await outcome(s.decide({ resourceType: "orders", actions: ["read", "read"], resourceIds: ["r-1"] }));

    expect("value" in decided ? decisionFor(decided.value, "read", "r-1") : decided.rejected).toBe("PERMIT");
  });
});

/* — the cache answers a pair with what the last call that asked for it returned ------------------- */

/*
 * Three calls. The first asks r-1 and caches its PERMIT. The second asks r-1 and r-2 with a cap of one
 * pair, so each goes to its own chunk, and answers per the case. The third asks r-1 alone, and whatever
 * it is asked, the transport answers DENY.
 */
describe("the cache answers a pair with what the last call that asked for it returned", () => {
  const BOTH: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] };
  const DENY_R1: Decision = { action: "read", resourceId: "r-1", effect: "DENY" };
  const PERMIT_R2: Decision = { action: "read", resourceId: "r-2", effect: "PERMIT" };

  function answer(settled: { value: readonly Decision[] } | { rejected: string }, resourceId: string): string {
    return "value" in settled ? decisionFor(settled.value, "read", resourceId) : settled.rejected;
  }

  async function threeCalls(first: () => unknown, second: () => unknown): Promise<readonly unknown[]> {
    let phase = 1;
    let calls = 0;
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) => {
          calls += 1;
          if (phase === 1) {
            return decisionSet([PERMIT_R1]);
          }
          if (phase === 2) {
            return (request.resourceIds[0] === "r-1" ? first() : second()) as DecisionSet;
          }
          return decisionSet([DENY_R1]);
        },
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();
    const one = answer(await outcome(s.decide(REQUEST)), "r-1");
    phase = 2;
    const two = await outcome(s.decide(BOTH));
    phase = 3;
    const before = calls;
    const three = answer(await outcome(s.decide(REQUEST)), "r-1");
    return [one, answer(two, "r-1"), answer(two, "r-2"), three, calls - before];
  }

  it.each([
    ["the chunk that asked for it rejects and another chunk carries its DENY", () => {
      throw new Error("down");
    }, () => decisionSet([PERMIT_R2, DENY_R1])],
    ["the chunk that asked for it answers without it and another chunk carries its DENY", () => decisionSet([]), () => decisionSet([PERMIT_R2, DENY_R1])],
    ["the chunk that asked for it answers for another application and another chunk carries its DENY", () => decisionSet([PERMIT_R1], "app-b"), () => decisionSet([PERMIT_R2, DENY_R1])],
    ["the chunk that asked for it rejects", () => {
      throw new Error("down");
    }, () => decisionSet([PERMIT_R2])],
  ] as const)("a pair a later call leaves absent is asked for again, not served an earlier PERMIT from the cache, when %s", async (_n, first, second) => {
    expect(await threeCalls(first, second)).toEqual(["PERMIT", "DENY", "PERMIT", "DENY", 1]);
  });

  it("a pair a later call leaves absent because an answer could not be read is asked for again", async () => {
    const unreadable = Object.defineProperty({ resourceId: "r-2", effect: "PERMIT" }, "action", {
      get() {
        throw new Error("unreadable");
      },
      enumerable: true,
    });

    expect(await threeCalls(() => decisionSet([PERMIT_R1]), () => decisionSet([unreadable as unknown as Decision]))).toEqual([
      "PERMIT",
      "DENY",
      "DENY",
      "DENY",
      1,
    ]);
  });

  it("a transport that hands the combined answer of grouped calls to the first leaves the others' pairs absent, and the cache does not answer them", async () => {
    const effects = new Map<string, "PERMIT" | "DENY">([["r-1", "PERMIT"], ["r-2", "PERMIT"]]);
    let pending: { request: DecisionRequest; resolve: (answer: DecisionSet) => void }[] = [];
    let calls = 0;
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: (_app, request) =>
          new Promise<DecisionSet>((resolve) => {
            pending.push({ request, resolve });
            if (pending.length === 1) {
              queueMicrotask(() => {
                const grouped = pending;
                pending = [];
                calls += 1;
                const ids = grouped.flatMap((p) => p.request.resourceIds);
                const combined = decisionSet(ids.map((resourceId) => ({ action: "read", resourceId, effect: effects.get(resourceId) ?? "DENY" })));
                grouped.forEach((p, i) => p.resolve(i === 0 ? combined : decisionSet([])));
              });
            }
          }),
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();
    const R2: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-2"] };

    const one = answer(await outcome(s.decide(R2)), "r-2");
    effects.set("r-2", "DENY");
    const two = await outcome(s.decide(BOTH));
    const before = calls;
    const three = answer(await outcome(s.decide(R2)), "r-2");

    expect([one, answer(two, "r-1"), answer(two, "r-2"), three, calls - before]).toEqual(["PERMIT", "PERMIT", "DENY", "DENY", 1]);
  });

  it.each([
    ["DENY, made more restrictive by a chunk that did not ask for it", () => decisionSet([PERMIT_R1]), () => decisionSet([PERMIT_R2, DENY_R1]), "DENY"],
    ["PERMIT", () => decisionSet([PERMIT_R1]), () => decisionSet([PERMIT_R2]), "PERMIT"],
  ] as const)("a pair a later call answers is served from the cache with that answer, %s, without asking", async (_n, first, second, effect) => {
    expect(await threeCalls(first, second)).toEqual(["PERMIT", effect, "PERMIT", effect, 0]);
  });
});

/* — what was asked is what the request asked, whatever the transport does with what it is handed ----- */

describe("what was asked is what the request asked, whatever the transport does with the request it is handed", () => {
  /** A transport that permits every pair it sends, and edits the request before or after sending it. */
  function answering(
    edit: (request: DecisionRequest) => void,
    when: "before sending" | "after sending",
  ): { transport: AuthorizationTransport; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      transport: {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) => {
          calls += 1;
          if (when === "before sending") {
            edit(request);
          }
          const answer = decisionSet(
            request.actions.flatMap((action) =>
              request.resourceIds.map((resourceId) => ({ action, resourceId, effect: "PERMIT" as const })),
            ),
          );
          if (when === "after sending") {
            edit(request);
          }
          return answer;
        },
      },
    };
  }
  const empty = (request: DecisionRequest): void => {
    (request.actions as string[]).length = 0;
    (request.resourceIds as string[]).length = 0;
  };
  const BOTH: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] };

  it.each([
    ["in one chunk", 100],
    ["in two chunks, which share the list of actions", 1],
  ] as const)("a transport that empties the request after it has sent it still has its answers read, %s", async (_n, cap) => {
    const { transport } = answering(empty, "after sending");
    const s = session(transport, { maxPairsPerRequest: cap });
    await s.start();

    const decided = await outcome(s.decide(BOTH));

    expect("value" in decided ? [decisionFor(decided.value, "read", "r-1"), decisionFor(decided.value, "read", "r-2")] : decided.rejected).toEqual([
      "PERMIT",
      "PERMIT",
    ]);
  });

  it("an id a transport adds to the request it is handed is not returned, and not served from the cache", async () => {
    const { transport, calls } = answering((request) => {
      (request.resourceIds as string[]).push("r-9");
    }, "before sending");
    const s = session(transport);
    await s.start();

    const decided = await outcome(s.decide(REQUEST));
    const before = calls();
    await s.decide({ resourceType: "orders", actions: ["read"], resourceIds: ["r-9"] });

    expect(["value" in decided ? decided.value.map((d) => d.resourceId) : decided.rejected, calls() - before]).toEqual([["r-1"], 1]);
  });
});

/* — asking for a chunk that fails is that chunk failing ----------------------------------------- */

describe("asking for a chunk that fails leaves that chunk's pairs DENY, and the call resolves", () => {
  const BOTH: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] };
  const PERMIT_R2: Decision = { action: "read", resourceId: "r-2", effect: "PERMIT" };

  function poisoned(field: "then" | "constructor"): Promise<DecisionSet> {
    const promise = Promise.resolve(decisionSet([PERMIT_R1]));
    Object.defineProperty(promise, field, {
      get() {
        throw new Error("poisoned");
      },
    });
    return promise;
  }

  it.each([
    ["a transport that throws before returning", () => {
      throw new Error("not configured");
    }],
    ["a promise whose then throws when it is followed", () => poisoned("then")],
    ["a promise whose constructor throws when it is read", () => poisoned("constructor")],
  ] as const)("%s", async (_n, first) => {
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: (_app, request) => (request.resourceIds[0] === "r-1" ? first() : Promise.resolve(decisionSet([PERMIT_R2]))),
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();

    const decided = await outcome(s.decide(BOTH));

    expect(
      "value" in decided ? [decisionFor(decided.value, "read", "r-1"), decisionFor(decided.value, "read", "r-2")] : decided.rejected,
    ).toEqual(["DENY", "PERMIT"]);
  });

  it("a fetchDecisions that is not a function leaves every pair DENY, and the call resolves", async () => {
    const s = session({ fetchPermissions: async () => menu(["read"]) } as unknown as AuthorizationTransport);
    await s.start();

    const decided = await outcome(s.decide(REQUEST));

    expect(decided).toEqual({ value: [] });
  });
});

/* — what is not read as a list is not a list that holds nothing ---------------------------------- */

/*
 * The chunk that asks for r-2 also answers r-1: a DENY for a pair it did not ask for, which can make
 * r-1 more restrictive and cannot answer it. Held in something that is not an array, or in an answer
 * that is a function, it is never read, and it is not known that nothing like it is there.
 */
describe("an answer that is not read as a list leaves every pair of the call absent", () => {
  const BOTH: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] };
  const DENY_R1: Decision = { action: "read", resourceId: "r-1", effect: "DENY" };
  const PERMIT_R2: Decision = { action: "read", resourceId: "r-2", effect: "PERMIT" };

  function both(settled: { value: readonly Decision[] } | { rejected: string }): readonly string[] | string {
    return "value" in settled
      ? [decisionFor(settled.value, "read", "r-1"), decisionFor(settled.value, "read", "r-2")]
      : settled.rejected;
  }

  async function askBoth(other: () => unknown): Promise<readonly unknown[]> {
    let calls = 0;
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) => {
          calls += 1;
          return (request.resourceIds[0] === "r-1" ? decisionSet([PERMIT_R1]) : other()) as DecisionSet;
        },
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();
    const cold = both(await outcome(s.decide(BOTH)));
    const again = both(await outcome(s.decide(BOTH)));
    return [cold, again, calls];
  }

  it.each([
    ["whose decisions is a Set", () => ({ app: APP, decisions: new Set([PERMIT_R2, DENY_R1]) })],
    ["whose decisions is a Map's values", () => ({ app: APP, decisions: new Map([["r-2", PERMIT_R2], ["r-1", DENY_R1]]).values() })],
    ["whose decisions is an array-like", () => ({ app: APP, decisions: { 0: PERMIT_R2, 1: DENY_R1, length: 2 } })],
    ["whose decisions is a string", () => ({ app: APP, decisions: "read" })],
    ["that is a function carrying app and decisions", () => Object.assign(() => undefined, { app: APP, decisions: [PERMIT_R2, DENY_R1] })],
    ["that is a function with no fields", () => () => undefined],
  ] as const)("an answer %s, beside a PERMIT for r-1 from the chunk that asked, reads DENY for both and caches nothing", async (_n, other) => {
    expect(await askBoth(other)).toEqual([["DENY", "DENY"], ["DENY", "DENY"], 4]);
  });

  it("the same answer in an array is read: r-1 is made DENY by the chunk that did not ask, r-2 answers, and both are cached", async () => {
    expect(await askBoth(() => ({ app: APP, decisions: [PERMIT_R2, DENY_R1] }))).toEqual([["DENY", "PERMIT"], ["DENY", "PERMIT"], 2]);
  });
});

/* — a value that is not an object is read the way an object is ------------------------------------- */

/*
 * An ordinary read of a field of a boolean goes through the prototype every boolean shares, so what
 * that prototype carries is what the boolean answers. These give it fields for the duration of one
 * call, and take them away before anything is asserted.
 */
describe("a value that is not an object is read the way an object is", () => {
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

  it.each(["DENY first", "PERMIT first"])("a boolean whose read names a pair and DENY, beside a PERMIT for that pair, answers DENY (%s)", async (order) => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => raw(...(order === "DENY first" ? [true, PERMIT_R1] : [PERMIT_R1, true])),
    });
    await s.start();

    const decided = await withBooleanFields({ action: "read", resourceId: "r-1", effect: "DENY" }, () => outcome(s.decide(REQUEST)));

    expect("value" in decided ? decisionFor(decided.value, "read", "r-1") : decided.rejected).toBe("DENY");
  });

  it("a boolean whose read names no pair, beside a PERMIT, is dropped and the PERMIT answers", async () => {
    const s = session({
      fetchPermissions: async () => menu(["read"]),
      fetchDecisions: async () => raw(true, PERMIT_R1),
    });
    await s.start();

    const decided = await outcome(s.decide(REQUEST));

    expect("value" in decided ? decisionFor(decided.value, "read", "r-1") : decided.rejected).toBe("PERMIT");
  });

  it("a menu entry that is a boolean whose read names an action and DENY, beside a PERMIT for that action, reads DENY", async () => {
    const s = session({
      fetchPermissions: async () => ({ app: APP, permissions: [{ action: "delete", effect: "PERMIT" }, true] }) as unknown as PermissionMenu,
      fetchDecisions: async () => decisionSet([]),
    });

    const started = await withBooleanFields({ action: "delete", effect: "DENY" }, () => outcome(s.start()));
    const state = s.getState();

    expect([started, state.status === "READY" ? permissionFor(state.permissions, "delete") : state.status]).toEqual([
      { value: undefined },
      "DENY",
    ]);
  });

  it("an answer that is a boolean whose read carries app and decisions is read as that answer", async () => {
    const s = session(
      {
        fetchPermissions: async () => menu(["read"]),
        fetchDecisions: async (_app, request) =>
          (request.resourceIds[0] === "r-1" ? decisionSet([PERMIT_R1]) : true) as unknown as DecisionSet,
      },
      { maxPairsPerRequest: 1 },
    );
    await s.start();

    const decided = await withBooleanFields(
      {
        app: APP,
        decisions: [
          { action: "read", resourceId: "r-2", effect: "PERMIT" },
          { action: "read", resourceId: "r-1", effect: "DENY" },
        ],
      },
      () => outcome(s.decide({ resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] })),
    );

    expect(
      "value" in decided ? [decisionFor(decided.value, "read", "r-1"), decisionFor(decided.value, "read", "r-2")] : decided.rejected,
    ).toEqual(["DENY", "PERMIT"]);
  });
});
