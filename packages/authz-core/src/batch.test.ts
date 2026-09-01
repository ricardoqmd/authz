import { describe, expect, it } from "vitest";

import { splitDecisionRequest } from "./batch.js";
import type { DecisionRequest } from "./transport.js";

/** Every (action, resource) pair a request stands for, as comparable strings. */
function pairsOf(request: DecisionRequest): string[] {
  const out: string[] = [];
  for (const action of request.actions) {
    for (const resourceId of request.resourceIds) {
      out.push(`${action}|${resourceId}`);
    }
  }
  return out;
}

function ids(count: number, prefix = "r"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

describe("splitDecisionRequest", () => {
  it("rejects a cap below one as a programming error", () => {
    const request: DecisionRequest = {
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1"],
    };
    expect(() => splitDecisionRequest(request, 0)).toThrow(RangeError);
    expect(() => splitDecisionRequest(request, -1)).toThrow(RangeError);
  });

  it("asks nothing when either side of the cross product is empty", () => {
    expect(
      splitDecisionRequest(
        { resourceType: "orders", actions: [], resourceIds: ["r-1"] },
        10,
      ),
    ).toEqual([]);
    expect(
      splitDecisionRequest(
        { resourceType: "orders", actions: ["read"], resourceIds: [] },
        10,
      ),
    ).toEqual([]);
  });

  /**
   * The assertion the prompt singles out, and it is two assertions on purpose: a splitter
   * that silently dropped pairs would satisfy the cap perfectly.
   */
  it("splits 50 resources by 3 actions under a cap of 100 within the cap AND without losing a pair", () => {
    const request: DecisionRequest = {
      resourceType: "orders",
      actions: ["read", "update", "delete"],
      resourceIds: ids(50),
    };

    const chunks = splitDecisionRequest(request, 100);

    for (const chunk of chunks) {
      expect(chunk.actions.length * chunk.resourceIds.length).toBeLessThanOrEqual(100);
      expect(chunk.resourceType).toBe("orders");
    }

    const produced = chunks.flatMap(pairsOf);
    const expected = pairsOf(request);
    expect(produced).toHaveLength(expected.length);
    expect(new Set(produced)).toEqual(new Set(expected));
  });

  it("carries every action in each chunk when the actions fit under the cap", () => {
    const request: DecisionRequest = {
      resourceType: "orders",
      actions: ["read", "update"],
      resourceIds: ids(7),
    };

    const chunks = splitDecisionRequest(request, 4);

    // floor(4 / 2) = 2 resources per chunk, all actions in each: 4, 4, 4, 2 pairs.
    expect(chunks.map((c) => c.resourceIds.length)).toEqual([2, 2, 2, 1]);
    for (const chunk of chunks) {
      expect(chunk.actions).toEqual(["read", "update"]);
    }
    expect(new Set(chunks.flatMap(pairsOf))).toEqual(new Set(pairsOf(request)));
  });

  it("splits the actions and pairs them with one resource at a time when the actions alone exceed the cap", () => {
    const request: DecisionRequest = {
      resourceType: "orders",
      actions: ["a", "b", "c", "d", "e"],
      resourceIds: ["r-1", "r-2"],
    };

    const chunks = splitDecisionRequest(request, 2);

    for (const chunk of chunks) {
      expect(chunk.resourceIds).toHaveLength(1);
      expect(chunk.actions.length * chunk.resourceIds.length).toBeLessThanOrEqual(2);
    }
    const produced = chunks.flatMap(pairsOf);
    expect(produced).toHaveLength(10);
    expect(new Set(produced)).toEqual(new Set(pairsOf(request)));
  });

  it("keeps both invariants across a range of caps and shapes", () => {
    for (const actionCount of [1, 2, 3, 5, 8]) {
      for (const resourceCount of [1, 4, 9, 50]) {
        for (const cap of [1, 2, 3, 7, 100]) {
          const request: DecisionRequest = {
            resourceType: "orders",
            actions: ids(actionCount, "a"),
            resourceIds: ids(resourceCount),
          };
          const chunks = splitDecisionRequest(request, cap);

          for (const chunk of chunks) {
            expect(chunk.actions.length * chunk.resourceIds.length).toBeLessThanOrEqual(cap);
          }
          const produced = chunks.flatMap(pairsOf);
          expect(produced).toHaveLength(actionCount * resourceCount);
          expect(new Set(produced).size).toBe(actionCount * resourceCount);
        }
      }
    }
  });
});

/**
 * authz-001b — MINOR I. A fractional cap passed `Number.isFinite` and then made the `slice`
 * truncation in the actions-exceed-the-cap branch produce a chunk one pair over the cap: the
 * guard admitted a value the algorithm below it cannot honour.
 */
describe("the cap is an integer", () => {
  it("rejects a fractional cap", () => {
    expect(() =>
      splitDecisionRequest(
        { resourceType: "doc", actions: ["read", "write"], resourceIds: ["r-1", "r-2"] },
        2.5,
      ),
    ).toThrow(RangeError);
  });
});
