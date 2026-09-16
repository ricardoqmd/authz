import { describe, expect, it } from "vitest";
import { AuthorizationTransportError } from "./transport.js";
import {
  type Decision,
  type DecisionEffect,
  type PermissionEntry,
  decisionFor,
  isRenderable,
  permissionFor,
} from "./decision.js";

describe("isRenderable", () => {
  it("renders a permit", () => {
    expect(isRenderable("PERMIT")).toBe(true);
  });

  it("does not render a deny", () => {
    expect(isRenderable("DENY")).toBe(false);
  });

  // The rule this library exists to protect: hiding on uncertainty turns
  // "depends" into "no". If someone ever makes CONDITIONAL behave like DENY,
  // this is the test that stops it.
  it("renders a conditional", () => {
    expect(isRenderable("CONDITIONAL")).toBe(true);
  });

  // An allowlist and not a denylist, and this is the case that says so.
  //
  // Written as `effect !== "DENY"` the three tests above still pass, because all three name
  // effects the union declares. What changes is an effect the union does NOT declare: a decision
  // point that grows a new one — a spelling change, a new verb, an unreleased feature — would have
  // its actions DRAWN instead of hidden. The collapse already ranks an unknown effect
  // restrictively, but the collapse is not what decides whether the button appears; this is.
  //
  // The cast is the point of the test rather than a shortcut around the types: the value being
  // modelled is one that arrives from the network, where the union is a hope and not a guarantee.
  it("does not render an effect it has never heard of", () => {
    expect(isRenderable("SOMETHING_NEW" as DecisionEffect)).toBe(false);
  });
});

describe("AuthorizationTransportError", () => {
  // The kind is pinned in several places because it decides a state. The NAME was not pinned
  // anywhere: it is what a `catch` prints and what a consumer's error reporting groups by, and
  // this class exists precisely so a transport failure is distinguishable from any other throw.
  it("names itself, so a catch can tell it apart from an ordinary Error", () => {
    const e = new AuthorizationTransportError("UNAVAILABLE", "down");

    expect(e.name).toBe("AuthorizationTransportError");
    expect(e.kind).toBe("UNAVAILABLE");
    expect(e).toBeInstanceOf(Error);
  });

  // No message: the kind stands in, so the error is never blank.
  it("falls back to the kind when no message is given", () => {
    expect(new AuthorizationTransportError("NO_ACCESS_IN_APP").message).toBe("NO_ACCESS_IN_APP");
  });
});

describe("decisionFor", () => {
  const decisions: readonly Decision[] = [
    { action: "approve", resourceId: "r-1", effect: "PERMIT" },
    { action: "approve", resourceId: "r-2", effect: "DENY" },
    { action: "cancel", resourceId: "r-1", effect: "CONDITIONAL" },
  ];

  it("returns the effect of the matching pair", () => {
    expect(decisionFor(decisions, "approve", "r-1")).toBe("PERMIT");
    expect(decisionFor(decisions, "cancel", "r-1")).toBe("CONDITIONAL");
  });

  // Fail closed. A truncated response, a batch chunk that failed, or a pair the
  // decision point simply did not return all land here, and all of them mean deny.
  it("denies a pair that is absent from the response", () => {
    expect(decisionFor(decisions, "approve", "r-99")).toBe("DENY");
    expect(decisionFor(decisions, "delete", "r-1")).toBe("DENY");
  });

  it("denies when the response is empty", () => {
    expect(decisionFor([], "approve", "r-1")).toBe("DENY");
  });

  // A lookup that compared only the action would answer PERMIT for ("approve",
  // "r-2") — the resource whose real answer is DENY. Matching on one half of the
  // pair is the mistake this pins, and a test with a single-action fixture cannot
  // see it.
  it("does not match a pair that shares only the action", () => {
    expect(decisionFor(decisions, "approve", "r-2")).toBe("DENY");
  });

  // The mirror image: comparing only the resource would answer PERMIT for
  // ("cancel", "r-1"), whose real answer is CONDITIONAL, and would answer
  // something other than DENY for an action nobody asked about.
  it("does not match a pair that shares only the resource", () => {
    expect(decisionFor(decisions, "delete", "r-2")).toBe("DENY");
  });
});

/**
 * Arrays a consumer assembles by hand, or receives from a transport that casts JSON: the element
 * types are what the array declares, not what it holds. `read` turns a throw into a value, so a
 * lookup that throws fails the assertion below it rather than the test around it.
 */
function read(lookup: () => unknown): unknown {
  try {
    return lookup();
  } catch (error) {
    return String(error);
  }
}

describe("decisionFor over elements that are not what the type says", () => {
  const PERMIT_R1: Decision = { action: "read", resourceId: "r-1", effect: "PERMIT" };
  const as = (...elements: readonly unknown[]) => elements as readonly Decision[];

  it("skips an element that does not name its pair, and reads the one after it", () => {
    const elements = as(null, undefined, "read", 7, { action: "read", effect: "DENY" }, PERMIT_R1);

    expect(read(() => decisionFor(elements, "read", "r-1"))).toBe("PERMIT");
  });

  // `undefined === undefined`: without the check on the element, a lookup whose resourceId is
  // undefined — a record with no id yet — matched an element with no resourceId and rendered.
  it("an element with no resourceId does not answer a lookup whose resourceId is undefined", () => {
    const lookup = () =>
      decisionFor(as({ action: "read", effect: "PERMIT" }), "read", undefined as unknown as string);

    expect(read(lookup)).toBe("DENY");
  });

  it.each([
    ["missing", { action: "read", resourceId: "r-1" }],
    ["null", { action: "read", resourceId: "r-1", effect: null }],
    ["a number", { action: "read", resourceId: "r-1", effect: 42 }],
    ["an object", { action: "read", resourceId: "r-1", effect: {} }],
  ] as const)("an element whose effect is %s reads DENY", (_n, element) => {
    expect(read(() => decisionFor(as(element), "read", "r-1"))).toBe("DENY");
  });

  // The element names the pair, so it is the one found: a PERMIT behind it for the same pair does
  // not get to answer instead.
  it("and it is not skipped in favour of a PERMIT for the same pair behind it", () => {
    const elements = as({ action: "read", resourceId: "r-1" }, PERMIT_R1);

    expect(read(() => decisionFor(elements, "read", "r-1"))).toBe("DENY");
  });

  // What is NOT refused. A string outside the union is an effect this version does not know, and
  // it is returned as it came: it does not render, and the collapse already ranks it restrictively.
  // An empty id and extra fields are an element the decision point sent on purpose.
  it("returns a string outside the union as it is", () => {
    const element = { action: "read", resourceId: "r-1", effect: "SOMETHING_NEW" };

    expect(read(() => decisionFor(as(element), "read", "r-1"))).toBe("SOMETHING_NEW");
  });

  it("answers an empty resource id that the lookup asks about", () => {
    const element = { action: "read", resourceId: "", effect: "PERMIT" };

    expect(read(() => decisionFor(as(element), "read", ""))).toBe("PERMIT");
  });

  it("reads an element that carries fields beyond the three", () => {
    const element = { ...PERMIT_R1, policy: "p-9" };

    expect(read(() => decisionFor(as(element), "read", "r-1"))).toBe("PERMIT");
  });
});

/*
 * The two lookups are read while a screen is being drawn, so they never throw: what they cannot use
 * reads as absent, and absent is DENY. That covers the collection too — `state.permissions` read off a
 * state that is not READY is `undefined` in JavaScript, and a throw there would take the render down.
 */
describe("a lookup over a collection it cannot use reads DENY and does not throw", () => {
  const NOT_A_COLLECTION = [
    ["undefined", undefined],
    ["null", null],
    ["an object", { action: "read", resourceId: "r-1", effect: "PERMIT" }],
    ["a string", "read"],
    ["a number", 7],
    // Not an array, and it would answer if it were searched: a `find` of its own hands back a PERMIT.
    ["an object with a find of its own", { find: () => ({ action: "read", resourceId: "r-1", effect: "PERMIT" }) }],
    // Not an array, and its `find` offers a PERMIT for the very key to whatever predicate it is given.
    [
      "an object whose find offers a PERMIT to the predicate",
      {
        find: (predicate: (element: unknown) => unknown) => {
          predicate({ action: "read", resourceId: "r-1", effect: "PERMIT" });
          return undefined;
        },
      },
    ],
  ] as const;

  it.each(NOT_A_COLLECTION)("decisionFor over %s", (_n, value) => {
    expect(read(() => decisionFor(value as unknown as readonly Decision[], "read", "r-1"))).toBe("DENY");
  });

  it.each(NOT_A_COLLECTION)("permissionFor over %s", (_n, value) => {
    expect(read(() => permissionFor(value as unknown as readonly PermissionEntry[], "read"))).toBe("DENY");
  });
});

/*
 * Same promise, over values that throw while they are searched. Each would have taken a screen down
 * from inside its render; each reads DENY instead. Each holds a PERMIT for the very pair asked about, so
 * the DENY is the throw read as absent, and not a lookup that came back empty-handed.
 */
describe("a lookup over something that throws while it is searched reads DENY and does not throw", () => {
  const PERMIT_PAIR = { action: "read", resourceId: "r-1", effect: "PERMIT" };
  const throwing = (field: string, over: object) =>
    Object.defineProperty({ ...over }, field, {
      get() {
        throw new Error("not loaded");
      },
      enumerable: true,
    });
  const revokedCollection = () => {
    const r = Proxy.revocable([PERMIT_PAIR], {});
    r.revoke();
    return r.proxy;
  };
  const THROWING = [
    ["a revoked Proxy as the collection", revokedCollection],
    ["an array whose find throws", () => Object.assign([PERMIT_PAIR], { find: () => { throw new Error("find"); } })],
    ["a Proxy whose get throws", () => new Proxy([PERMIT_PAIR], { get: () => { throw new Error("get"); } })],
    ["an element whose effect accessor throws", () => [throwing("effect", { action: "read", resourceId: "r-1" }), PERMIT_PAIR]],
  ] as const;

  it.each(THROWING)("decisionFor over %s", (_n, make) => {
    expect(read(() => decisionFor(make() as unknown as readonly Decision[], "read", "r-1"))).toBe("DENY");
  });

  it.each(THROWING)("permissionFor over %s", (_n, make) => {
    expect(read(() => permissionFor(make() as unknown as readonly PermissionEntry[], "read"))).toBe("DENY");
  });
});

describe("permissionFor over entries that are not what the type says", () => {
  const as = (...entries: readonly unknown[]) => entries as readonly PermissionEntry[];

  it("skips an entry that does not name its action, and reads the one after it", () => {
    const menu = as(
      null,
      undefined,
      "read",
      7,
      { effect: "DENY" },
      { action: "read", effect: "PERMIT" },
    );

    expect(read(() => permissionFor(menu, "read"))).toBe("PERMIT");
  });

  it("an entry with no action does not answer a lookup whose action is undefined", () => {
    const lookup = () => permissionFor(as({ effect: "PERMIT" }), undefined as unknown as string);

    expect(read(lookup)).toBe("DENY");
  });

  it.each([
    ["missing", { action: "read" }],
    ["null", { action: "read", effect: null }],
    ["a number", { action: "read", effect: 42 }],
  ] as const)("an entry whose effect is %s reads DENY", (_n, entry) => {
    expect(read(() => permissionFor(as(entry), "read"))).toBe("DENY");
  });
});

describe("permissionFor", () => {
  const permissions: readonly PermissionEntry[] = [
    { action: "create", effect: "PERMIT" },
    { action: "approve", effect: "CONDITIONAL", dependsOn: ["resource.areaId"] },
    { action: "purge", effect: "DENY" },
  ];

  it("returns the effect of the listed action", () => {
    expect(permissionFor(permissions, "create")).toBe("PERMIT");
    expect(permissionFor(permissions, "approve")).toBe("CONDITIONAL");
    expect(permissionFor(permissions, "purge")).toBe("DENY");
  });

  it("denies an action that is not listed", () => {
    expect(permissionFor(permissions, "anything-else")).toBe("DENY");
  });

  it("denies every action when the menu is empty", () => {
    expect(permissionFor([], "create")).toBe("DENY");
  });
});

describe("the effect a lookup returns is the effect it checked", () => {
  it("an element whose effect answers differently on each read reads what it answered first", () => {
    let reads = 0;
    const element = Object.defineProperty({ action: "read", resourceId: "r-1" }, "effect", {
      get() {
        reads += 1;
        return reads === 1 ? "DENY" : "PERMIT";
      },
      enumerable: true,
    });

    expect(read(() => decisionFor([element] as unknown as readonly Decision[], "read", "r-1"))).toBe("DENY");
  });
});

/*
 * A collection can name a pair more than once — an array assembled by hand, or two answers put
 * together — and the element after the first one that names it may be its DENY. Each case below holds
 * a PERMIT for the pair first, so an answer of PERMIT is the lookup that stopped at it.
 */
describe("a lookup reads every element, not the first one that names the pair", () => {
  const PERMIT_PAIR = { action: "read", resourceId: "r-1", effect: "PERMIT" };
  const PERMIT_ENTRY = { action: "read", effect: "PERMIT" };
  const fn = (fields: object) => Object.assign(function element() {}, fields);
  const throwsOnRead = Object.defineProperty({}, "action", {
    get() {
      throw new Error("not loaded");
    },
    enumerable: true,
  });
  const decisionsAfter = [
    ["a DENY for the same pair", { action: "read", resourceId: "r-1", effect: "DENY" }, "DENY"],
    ["a CONDITIONAL for the same pair", { action: "read", resourceId: "r-1", effect: "CONDITIONAL" }, "CONDITIONAL"],
    ["an element that throws when read", throwsOnRead, "DENY"],
    ["a function carrying a DENY for the same pair", fn({ action: "read", resourceId: "r-1", effect: "DENY" }), "DENY"],
    ["a function carrying nothing", fn({}), "DENY"],
  ] as const;

  it.each(decisionsAfter)("decisionFor over a PERMIT, then %s", (_n, after, expected) => {
    expect(read(() => decisionFor([PERMIT_PAIR, after] as unknown as readonly Decision[], "read", "r-1"))).toBe(expected);
  });

  const entriesAfter = [
    ["a DENY for the same action", { action: "read", effect: "DENY" }, "DENY"],
    ["a CONDITIONAL for the same action", { action: "read", effect: "CONDITIONAL" }, "CONDITIONAL"],
    ["an entry that throws when read", throwsOnRead, "DENY"],
    ["a function carrying a DENY for the same action", fn({ action: "read", effect: "DENY" }), "DENY"],
  ] as const;

  it.each(entriesAfter)("permissionFor over a PERMIT, then %s", (_n, after, expected) => {
    expect(read(() => permissionFor([PERMIT_ENTRY, after] as unknown as readonly PermissionEntry[], "read"))).toBe(expected);
  });

  it("an element for another pair after the PERMIT changes nothing", () => {
    const other = { action: "read", resourceId: "r-2", effect: "DENY" };

    expect(read(() => decisionFor([PERMIT_PAIR, other] as readonly Decision[], "read", "r-1"))).toBe("PERMIT");
  });

  it("an array whose own find hands back a PERMIT without searching answers DENY", () => {
    const lying = Object.assign([] as Decision[], { find: () => PERMIT_PAIR });

    expect(read(() => decisionFor(lying, "read", "r-1"))).toBe("DENY");
  });
});

/*
 * An ordinary read of a field of a boolean goes through the prototype every boolean shares. These
 * give it fields for the duration of one lookup, and take them away before anything is asserted.
 */
describe("a lookup reads a value that is not an object the way it reads an object", () => {
  function withBooleanFields<T>(fields: Record<string, unknown>, run: () => T): T {
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(Boolean.prototype, key, { value, writable: true, configurable: true });
    }
    try {
      return run();
    } finally {
      for (const key of Object.keys(fields)) {
        delete (Boolean.prototype as unknown as Record<string, unknown>)[key];
      }
    }
  }
  const PERMIT_PAIR = { action: "read", resourceId: "r-1", effect: "PERMIT" };
  const PERMIT_ENTRY = { action: "read", effect: "PERMIT" };

  it("decisionFor over a PERMIT and a boolean whose read names the pair and DENY reads DENY", () => {
    const got = withBooleanFields({ action: "read", resourceId: "r-1", effect: "DENY" }, () =>
      read(() => decisionFor([PERMIT_PAIR, true] as unknown as readonly Decision[], "read", "r-1")),
    );

    expect(got).toBe("DENY");
  });

  it("permissionFor over a PERMIT and a boolean whose read names the action and DENY reads DENY", () => {
    const got = withBooleanFields({ action: "read", effect: "DENY" }, () =>
      read(() => permissionFor([PERMIT_ENTRY, true] as unknown as readonly PermissionEntry[], "read")),
    );

    expect(got).toBe("DENY");
  });

  it("a boolean whose read names nothing changes nothing", () => {
    expect([
      read(() => decisionFor([PERMIT_PAIR, true] as unknown as readonly Decision[], "read", "r-1")),
      read(() => permissionFor([PERMIT_ENTRY, true] as unknown as readonly PermissionEntry[], "read")),
    ]).toEqual(["PERMIT", "PERMIT"]);
  });
});
