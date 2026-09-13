import { describe, expect, it, vi } from "vitest";

import { decisionFor, type Decision } from "./decision.js";
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
   * DENY. Giving both PERMIT hides the collision entirely — one collapsed PERMIT looks exactly
   * like no collision at all — and measured, written that way every separator mutation stayed
   * green.
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
