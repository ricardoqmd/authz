/**
 * Splitting a decision request into chunks a decision point will accept.
 *
 * A request is a cross product: every action against every resource id. Asking for 300
 * resources by 5 actions is 1500 pairs in one call, and every engine has a maximum. This
 * file turns one request into several, without losing or duplicating a single pair.
 */

import type { DecisionRequest } from "./transport.js";

/**
 * Split a request so that every chunk stays within `maxPairs`.
 *
 * **`maxPairs` is a parameter and never a literal in this package.** The maximum belongs to
 * the engine that answers; a number compiled in here would be someone else's limit, right
 * until the day it is not, and the failure would be a rejected request in production rather
 * than a failing test.
 *
 * The algorithm has two shapes, and which one applies depends on whether the actions alone
 * already exceed the cap:
 *
 * - **Actions fit.** Each chunk carries *all* the actions and as many resource ids as fit:
 *   `floor(maxPairs / actions.length)`, which is at least one. This is the common case and
 *   it keeps the number of calls low.
 * - **Actions do not fit.** The actions are split into chunks of `maxPairs` and each one is
 *   paired with a single resource id. There is no way to do better: one resource with more
 *   actions than the cap cannot be asked in one call.
 *
 * Two invariants hold in both shapes, and the tests pin both — the first alone is satisfied
 * by a splitter that silently drops pairs:
 *
 * 1. every chunk satisfies `actions.length * resourceIds.length <= maxPairs`;
 * 2. the union of the chunks' (action, resource) pairs equals the original set exactly.
 *
 * @throws RangeError if `maxPairs` is less than 1. That is a programming error — a cap of
 *     zero asks for nothing to be askable — and it fails loudly rather than returning an
 *     empty list that would read as "nothing to ask" and resolve every pair to `DENY`.
 */
export function splitDecisionRequest(
  request: DecisionRequest,
  maxPairs: number,
): readonly DecisionRequest[] {
  // Integer, not merely finite: with a fractional cap the slice truncation in the
  // actions-exceed-the-cap branch produces a chunk one pair over it.
  if (!Number.isInteger(maxPairs) || maxPairs < 1) {
    throw new RangeError(
      `maxPairs must be an integer greater than or equal to 1, received ${String(maxPairs)}`,
    );
  }

  const { resourceType, actions, resourceIds } = request;

  // Nothing to ask. Note this is not the same as a cap of zero: an empty request is a
  // legitimate runtime condition, an impossible cap is a bug.
  if (actions.length === 0 || resourceIds.length === 0) {
    return [];
  }

  if (actions.length <= maxPairs) {
    const perChunk = Math.floor(maxPairs / actions.length);
    return chunk(resourceIds, perChunk).map((ids) => ({
      resourceType,
      actions,
      resourceIds: ids,
    }));
  }

  const actionChunks = chunk(actions, maxPairs);
  const out: DecisionRequest[] = [];
  for (const resourceId of resourceIds) {
    for (const actionChunk of actionChunks) {
      out.push({ resourceType, actions: actionChunk, resourceIds: [resourceId] });
    }
  }
  return out;
}

/** Consecutive groups of at most `size`. `size` is always at least 1 when called. */
function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: (readonly T[])[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
