import { describe, expect, it } from "vitest";

import {
  createAuthorizationSession,
  type AuthorizationSession,
  type DecisionSet,
  type PermissionMenu,
} from "@ricardoqmd/authz-core";

import type { AuthorizationContext, ContextTransport } from "./context.js";
import { createContextSession } from "./session.js";

/**
 * THE COMPOSITION TEST. Every other test in this package runs against a session double, and a double
 * agrees with whatever the test that wrote it believed. This file builds the REAL core session and
 * passes it through `buildSession`, which is the only place the two packages meet.
 *
 * It is also the first runtime import of `@ricardoqmd/authz-core` anywhere in this package: `src`
 * imports it with `import type` and nothing else, so until this file existed the two packages were
 * never loaded into the same process by a test.
 *
 * What that buys, concretely: the README says `IN_CONTEXT` nests the core's state, and the source
 * says the core repaints the optimistic paint by itself. Both were reasoned. Below they are the
 * recorded emission sequence.
 */

const APP = "app-a";

function context(contextId: string): AuthorizationContext {
  return { contextId, label: contextId, hasAccess: true };
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

function label(state: { status: string; permissions?: { status: string } }): string {
  return state.permissions === undefined ? `${state.status}/-` : `${state.status}/${state.permissions.status}`;
}

describe("the real core through the factory", () => {
  it("nests the core's state, and the core closes the optimistic-paint window itself", async () => {
    const menu = deferred<PermissionMenu>();
    const contextTransport: ContextTransport = {
      listContexts: async () => [context("ctx-a")],
    };
    let built = 0;
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: () => {
        built += 1;
        return createAuthorizationSession({
          app: APP,
          maxPairsPerRequest: 50,
          transport: {
            fetchPermissions: async () => menu.promise,
            fetchDecisions: async () => ({ app: APP, decisions: [] }),
          },
        });
      },
    });

    const seen: string[] = [];
    session.subscribe((state) => seen.push(label(state)));

    const starting = session.start();
    await settle();

    // ONE context, so `start()` activates it with no picker and the optimistic paint runs. The core's
    // menu fetch is parked, so nothing below can be the fetch having resolved.
    expect(seen).toEqual(["LOADING_CONTEXTS/-", "IN_CONTEXT/IDLE", "IN_CONTEXT/LOADING"]);
    expect(built).toBe(1);

    // ASSERTION 2. The menu the transport returned, surfaced nested under this layer's own status.
    menu.resolve({ app: APP, permissions: [{ action: "read", effect: "PERMIT" }] });
    await starting;
    await settle();

    // TWO `IN_CONTEXT/READY`, and they are not a defect of the core: the subscription registered in
    // `activate` repaints when the core emits READY, and `activate` repaints again on its own after
    // `await session.start()` returns. `setState` does not de-duplicate. 📐 A double faithful to the
    // core's emission order produces this exact five-element sequence too, so the real core and the
    // doubles agree here down to the repetition.
    expect(seen).toEqual([
      "LOADING_CONTEXTS/-",
      "IN_CONTEXT/IDLE",
      "IN_CONTEXT/LOADING",
      "IN_CONTEXT/READY",
      "IN_CONTEXT/READY",
    ]);
    expect(session.getState()).toEqual({
      status: "IN_CONTEXT",
      contextId: "ctx-a",
      permissions: {
        status: "READY",
        permissions: [{ action: "read", effect: "PERMIT" }],
      },
    });
  });

  it("the core emits LOADING in the SAME synchronous turn as the optimistic paint", async () => {
    const menu = deferred<PermissionMenu>();
    const contextTransport: ContextTransport = {
      listContexts: async () => [context("ctx-a"), context("ctx-b")],
    };
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: () =>
        createAuthorizationSession({
          app: APP,
          maxPairsPerRequest: 50,
          transport: {
            fetchPermissions: async () => menu.promise,
            fetchDecisions: async () => ({ app: APP, decisions: [] }),
          },
        }),
    });
    await session.start();

    const seen: string[] = [];
    session.subscribe((state) => seen.push(label(state)));

    // NOT awaited, and not a microtask later either. `activate` runs synchronously up to its own
    // `await session.start()`, and the core's `start()` runs synchronously up to ITS first await —
    // emitting LOADING on the way. So the window the optimistic paint covers never opens with the
    // real core: both emissions are already recorded before this turn yields.
    void session.selectContext("ctx-a");

    expect(seen).toEqual(["IN_CONTEXT/IDLE", "IN_CONTEXT/LOADING"]);
    menu.resolve({ app: APP, permissions: [] });
    await settle();
  });

  it("a decision in flight under ctx-a returns [] after a switch, with the real core discarded", async () => {
    const parked = deferred<DecisionSet>();
    const cores: AuthorizationSession[] = [];
    const contextTransport: ContextTransport = {
      listContexts: async () => [context("ctx-a"), context("ctx-b")],
    };
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: (contextId) => {
        const core = createAuthorizationSession({
          app: APP,
          maxPairsPerRequest: 50,
          transport: {
            fetchPermissions: async () => ({
              app: APP,
              permissions: [{ action: "read", effect: "PERMIT" }],
            }),
            fetchDecisions: async () =>
              contextId === "ctx-a"
                ? parked.promise
                : { app: APP, decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" }] },
          },
        });
        cores.push(core);
        return core;
      },
    });

    await session.start();
    await session.selectContext("ctx-a");
    expect(cores).toHaveLength(1);

    const inFlight = session.decide({
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1"],
    });
    await settle();

    await session.selectContext("ctx-b");
    expect(cores).toHaveLength(2);

    // ASSERTION 4, and it is what makes the five-combination table's menu column true rather than a
    // property of a double: the abandoned core really is closed, and a closed core is IDLE.
    expect(cores[0]?.getState()).toEqual({ status: "IDLE" });
    expect(cores[1]?.getState()).toMatchObject({ status: "READY" });

    // The decision was correct FOR ctx-a. Delivering it now would paint it under ctx-b's label.
    parked.resolve({
      app: APP,
      decisions: [{ action: "read", resourceId: "r-1", effect: "PERMIT" }],
    });
    expect(await inFlight).toEqual([]);
  });

  /*
   * THE OTHER HALF. Every case above is fail-closed: each one asserts that something does NOT reach
   * the consumer, so an implementation that never answered would satisfy all of them. 📐 That was
   * measured, in the past tense on purpose: BEFORE this case existed, a `decide()` returning the
   * empty list forever left all four of them green, and emptying the CORE's `decide()` left this
   * package's entire suite of 46 green. **This case is what changed that.** With it, the same
   * mutation of the core exits 1 here and this is the only case that catches it — so the sentence
   * above describes the tree this file replaced, not the tree it ships in.
   *
   * Both effects are asserted, not just the PERMIT: an implementation that answered PERMIT to
   * everything would pass a PERMIT-only assertion.
   */
  it("a decision with nothing in flight comes back with the effects the transport returned", async () => {
    const session = createContextSession({
      app: APP,
      contextTransport: { listContexts: async () => [context("ctx-a")] },
      buildSession: () =>
        createAuthorizationSession({
          app: APP,
          maxPairsPerRequest: 50,
          transport: {
            fetchPermissions: async () => ({
              app: APP,
              permissions: [{ action: "read", effect: "PERMIT" }],
            }),
            fetchDecisions: async () => ({
              app: APP,
              decisions: [
                { action: "read", resourceId: "r-1", effect: "PERMIT" },
                { action: "read", resourceId: "r-2", effect: "DENY" },
              ],
            }),
          },
        }),
    });

    await session.start();
    expect(session.getState()).toMatchObject({ status: "IN_CONTEXT", contextId: "ctx-a" });

    const decided = await session.decide({
      resourceType: "orders",
      actions: ["read"],
      resourceIds: ["r-1", "r-2"],
    });

    expect(decided).toEqual([
      { action: "read", resourceId: "r-1", effect: "PERMIT" },
      { action: "read", resourceId: "r-2", effect: "DENY" },
    ]);
  });

  it("close() leaves the real core IDLE, which is what the abandoned-session rows rest on", async () => {
    const cores: AuthorizationSession[] = [];
    const contextTransport: ContextTransport = {
      listContexts: async () => [context("ctx-a")],
    };
    const session = createContextSession({
      app: APP,
      contextTransport,
      buildSession: () => {
        const core = createAuthorizationSession({
          app: APP,
          maxPairsPerRequest: 50,
          transport: {
            fetchPermissions: async () => ({
              app: APP,
              permissions: [{ action: "read", effect: "PERMIT" }],
            }),
            fetchDecisions: async () => ({ app: APP, decisions: [] }),
          },
        });
        cores.push(core);
        return core;
      },
    });

    await session.start();
    expect(cores[0]?.getState()).toMatchObject({ status: "READY" });

    session.close();

    expect(cores[0]?.getState()).toEqual({ status: "IDLE" });
    expect(session.getState()).toEqual({ status: "IDLE" });
  });
});
