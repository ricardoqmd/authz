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
