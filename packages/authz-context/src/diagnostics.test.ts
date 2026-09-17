import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthorizationSession, AuthorizationState, Decision, DecisionRequest } from "@ricardoqmd/authz-core";

import type { AuthorizationContext, ContextTransport } from "./context.js";
import {
  createContextSession,
  type ContextDiagnostic,
  type ContextSession,
  type ContextSessionOptions,
} from "./session.js";

const APP = "app-a";

const REQUEST: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1"] };

const PERMIT: Decision = { action: "read", resourceId: "r-1", effect: "PERMIT" };

function context(contextId: string, hasAccess = true): AuthorizationContext {
  return { contextId, label: contextId, hasAccess };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function delivered(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeSession(over: { start?: () => Promise<void>; decide?: () => Promise<readonly Decision[]> } = {}): AuthorizationSession {
  let state: AuthorizationState = { status: "IDLE" };
  const listeners = new Set<(s: AuthorizationState) => void>();
  return {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start:
      over.start ??
      (async () => {
        state = { status: "READY", permissions: [{ action: "read", effect: "PERMIT" }] };
        for (const l of listeners) l(state);
      }),
    decide: over.decide ?? (async () => [PERMIT]),
    close: () => {
      listeners.clear();
    },
  };
}

function heard(
  listContexts: ContextTransport["listContexts"],
  options: Partial<ContextSessionOptions> = {},
): { session: ContextSession; events: ContextDiagnostic[] } {
  const events: ContextDiagnostic[] = [];
  const session = createContextSession({
    app: APP,
    contextTransport: { listContexts },
    buildSession: () => fakeSession(),
    onDiagnostic: (event) => {
      events.push(event);
    },
    ...options,
  });
  return { session, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("onDiagnostic is a function or nothing", () => {
  it.each([
    ["a string", "field-secret", "string"],
    ["a number", 42, "number"],
    ["null", null, "null"],
    ["an array", ["field-secret"], "an array"],
    ["an object", { toString: () => "field-secret" }, "object"],
  ])("refuses %s at construction, naming its type and never its value", (_label, value, type) => {
    const build = () =>
      createContextSession({
        app: APP,
        contextTransport: { listContexts: async () => [] },
        buildSession: () => fakeSession(),
        onDiagnostic: value as unknown as ContextSessionOptions["onDiagnostic"],
      });

    expect(build).toThrow(RangeError);
    expect(build).toThrow(`onDiagnostic must be a function, received ${type}`);
    expect(() => build()).not.toThrow(/field-secret/);
  });

  it("accepts it omitted and given as undefined", () => {
    const options = { app: APP, contextTransport: { listContexts: async () => [] }, buildSession: () => fakeSession() };

    expect(() => createContextSession(options)).not.toThrow();
    expect(() => createContextSession({ ...options, onDiagnostic: undefined })).not.toThrow();
  });
});

describe("an event is handed over in a task of its own", () => {
  it("does not run before the call that raised it has settled, and runs after", async () => {
    const { session, events } = heard(async () => [context("ctx-a")]);

    await session.start();
    const whenSettled = events.length;
    await delivered();

    expect([whenSettled, events]).toEqual([0, [{ kind: "session-built" }]]);
  });

  it("schedules nothing when no callback is given, and one task per event when one is", async () => {
    vi.useFakeTimers();
    const run = async (onDiagnostic: ContextSessionOptions["onDiagnostic"]) => {
      const session = createContextSession({
        app: APP,
        contextTransport: { listContexts: async () => [context("ctx-a"), context("ctx-b")] },
        buildSession: () => fakeSession(),
        ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
      });
      await session.start();
      await session.selectContext("ctx-a");
      await session.selectContext("ctx-b");
      return vi.getTimerCount();
    };

    expect([await run(undefined), await run(() => undefined)]).toEqual([0, 2]);
  });

  it("what the callback throws does not leave the task it runs in", async () => {
    vi.useFakeTimers();
    const { session } = heard(async () => [context("ctx-a")], {
      onDiagnostic: () => {
        throw new Error("the consumer's callback is broken");
      },
    });

    await session.start();

    expect(vi.getTimerCount()).toBe(1);
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it("a callback that throws changes nothing the session does, and every later event still arrives", async () => {
    const thrown: ContextDiagnostic[] = [];
    const observe = async (onDiagnostic: ContextSessionOptions["onDiagnostic"]) => {
      const session = createContextSession({
        app: APP,
        contextTransport: { listContexts: async () => [context("ctx-a"), context("ctx-b")] },
        buildSession: () => fakeSession(),
        ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
      });
      const states: unknown[] = [];
      session.subscribe((state) => states.push(state));
      await session.start();
      await session.selectContext("ctx-a");
      await delivered();
      await session.selectContext("ctx-b");
      await delivered();
      const decisions = await session.decide(REQUEST);
      return { states, decisions, state: session.getState(), last: session.lastListedContexts() };
    };

    const quiet = await observe(undefined);
    const loud = await observe((event) => {
      thrown.push(event);
      throw new Error("the consumer's callback is broken");
    });

    expect(loud).toEqual(quiet);
    expect(kinds(thrown)).toEqual(["session-built", "session-built"]);
  });

  it("each event is a frozen object holding its kind and the fields its kind declares", async () => {
    let call = 0;
    const { session, events } = heard(async () => {
      call += 1;
      if (call === 1) return [context("ctx-a")];
      throw new Error("down");
    });

    await session.start();
    await session.start();
    await delivered();

    expect(events.map((event) => Object.isFrozen(event))).toEqual([true, true]);
    expect(events).toEqual([{ kind: "session-built" }, { kind: "listing-unavailable", reason: "rejected" }]);
  });
});

function kinds(events: readonly ContextDiagnostic[]): string[] {
  return events.map((event) => event.kind);
}

describe("an event carries no value read out of an answer", () => {
  it("not a context, an identifier, a label or an error, whatever the listing holds", async () => {
    const SECRET = "answer-secret";
    const listings: (() => Promise<unknown>)[] = [
      async () => [context(SECRET), context(`${SECRET}-2`)],
      async () => [context(SECRET)],
      async () => [context(SECRET, false)],
      async () => Promise.reject(new Error(SECRET)),
      async () => ({ contexts: [context(SECRET)] }),
      async () => [{ get contextId(): string { throw new Error(SECRET); } }],
      async () => SECRET,
    ];
    const events: ContextDiagnostic[] = [];
    for (const listing of listings) {
      const session = createContextSession({
        app: APP,
        contextTransport: { listContexts: listing as ContextTransport["listContexts"] },
        buildSession: () => fakeSession(),
        onDiagnostic: (event) => events.push(event),
      });
      await session.start();
      if (session.getState().status === "CHOOSING_CONTEXT") await session.selectContext(SECRET);
      await session.decide(REQUEST);
    }
    await delivered();

    expect(new Set(kinds(events))).toEqual(new Set(["session-built", "listing-unavailable"]));
    expect(JSON.stringify(events)).not.toContain(SECRET);
    for (const event of events) {
      for (const value of Object.values(event)) {
        expect(typeof value).toBe("string");
      }
    }
  });
});

describe("session-built", () => {
  it("is raised once for each activation that builds a session, a context entered again included", async () => {
    const built: string[] = [];
    const { session, events } = heard(async () => [context("ctx-a"), context("ctx-b")], {
      buildSession: (id) => {
        built.push(id);
        return fakeSession();
      },
    });

    await session.start();
    await session.selectContext("ctx-a");
    await session.selectContext("ctx-b");
    await session.selectContext("ctx-a");
    await delivered();

    expect([built, kinds(events)]).toEqual([
      ["ctx-a", "ctx-b", "ctx-a"],
      ["session-built", "session-built", "session-built"],
    ]);
  });

  it("is not raised for a context without access, a picker, an empty list, or a decide()", async () => {
    const lists = [[context("ctx-a", false)], [context("ctx-a"), context("ctx-b")], []];
    const events: ContextDiagnostic[] = [];
    for (const list of lists) {
      const session = createContextSession({
        app: APP,
        contextTransport: { listContexts: async () => list },
        buildSession: () => fakeSession(),
        onDiagnostic: (event) => events.push(event),
      });
      await session.start();
      await session.decide(REQUEST);
    }
    await delivered();

    expect(events).toEqual([]);
  });

  it("is not raised when buildSession throws", async () => {
    const { session, events } = heard(async () => [context("ctx-a")], {
      buildSession: () => {
        throw new Error("the consumer's factory is broken");
      },
    });

    await expect(session.start()).rejects.toThrow("the consumer's factory is broken");
    await delivered();

    expect(events).toEqual([]);
  });
});

describe("listing-unavailable", () => {
  it.each<[string, () => Promise<unknown>, string]>([
    ["asking for the list rejects", async () => Promise.reject(new Error("down")), "rejected"],
    ["asking for the list throws before returning", () => {
      throw new Error("down");
    }, "rejected"],
    ["the answer is null", async () => null, "not-a-list"],
    ["the answer is an object", async () => ({ contexts: [] }), "not-a-list"],
    ["no element names a context", async () => [{ label: "x" }], "not-a-list"],
    ["an element throws when read", async () => [{ get contextId(): string { throw new Error("x"); } }], "not-a-list"],
  ])("is raised when %s, with that reason, beside UNAVAILABLE", async (_label, listContexts, reason) => {
    const { session, events } = heard(listContexts as ContextTransport["listContexts"]);

    await session.start();
    await delivered();

    expect([session.getState().status, events]).toEqual(["UNAVAILABLE", [{ kind: "listing-unavailable", reason }]]);
  });

  it.each<[string, () => Promise<unknown>, string]>([
    ["an empty list", async () => [], "NO_CONTEXTS"],
    ["a list to choose from", async () => [context("ctx-a"), context("ctx-b")], "CHOOSING_CONTEXT"],
    ["a list with one element that names no context beside two that do", async () => [{ label: "x" }, context("ctx-a"), context("ctx-b")], "CHOOSING_CONTEXT"],
  ])("is not raised for %s", async (_label, listContexts, status) => {
    const { session, events } = heard(listContexts as ContextTransport["listContexts"]);

    await session.start();
    await delivered();

    expect([session.getState().status, events]).toEqual([status, []]);
  });
});

describe("answer-discarded", () => {
  it.each([
    ["resolves", (parked: ReturnType<typeof deferred<readonly AuthorizationContext[]>>) => parked.resolve([context("ctx-z"), context("ctx-y")])],
    ["rejects", (parked: ReturnType<typeof deferred<readonly AuthorizationContext[]>>) => parked.reject(new Error("down"))],
  ])("is raised for a listing that %s after a later start()", async (_label, settle) => {
    const parked = deferred<readonly AuthorizationContext[]>();
    let call = 0;
    const { session, events } = heard(() => (call++ === 0 ? parked.promise : Promise.resolve([context("ctx-a"), context("ctx-b")])));

    const first = session.start();
    await session.start();
    settle(parked);
    await first;
    await delivered();

    expect(events).toEqual([{ kind: "answer-discarded", operation: "listing" }]);
  });

  it("is raised for a listing that arrives after close()", async () => {
    const parked = deferred<readonly AuthorizationContext[]>();
    const { session, events } = heard(() => parked.promise);

    const first = session.start();
    session.close();
    parked.resolve([context("ctx-a"), context("ctx-b")]);
    await first;
    await delivered();

    expect(events).toEqual([{ kind: "answer-discarded", operation: "listing" }]);
  });

  it("is raised for an activation whose session starts after the subject moved to another context", async () => {
    const parked = deferred<void>();
    const { session, events } = heard(async () => [context("ctx-a"), context("ctx-b")], {
      buildSession: (id) => fakeSession(id === "ctx-a" ? { start: () => parked.promise } : {}),
    });

    await session.start();
    const first = session.selectContext("ctx-a");
    await session.selectContext("ctx-b");
    parked.resolve();
    await first;
    await delivered();

    expect(events).toEqual([
      { kind: "session-built" },
      { kind: "session-built" },
      { kind: "answer-discarded", operation: "activation" },
    ]);
  });

  it("is raised for decisions that arrive after the subject moved, and the call resolves with the empty list", async () => {
    const parked = deferred<readonly Decision[]>();
    const { session, events } = heard(async () => [context("ctx-a"), context("ctx-b")], {
      buildSession: (id) => fakeSession(id === "ctx-a" ? { decide: () => parked.promise } : {}),
    });

    await session.start();
    await session.selectContext("ctx-a");
    const deciding = session.decide(REQUEST);
    await session.selectContext("ctx-b");
    parked.resolve([PERMIT]);
    const decisions = await deciding;
    await delivered();

    expect([decisions, kinds(events)]).toEqual([[], ["session-built", "session-built", "answer-discarded"]]);
    expect(events[2]).toEqual({ kind: "answer-discarded", operation: "decide" });
  });

  it("is not raised for a listing, an activation or decisions that arrive in time", async () => {
    const { session, events } = heard(async () => [context("ctx-a"), context("ctx-b")]);

    await session.start();
    await session.selectContext("ctx-a");
    await session.decide(REQUEST);
    await session.selectContext("ctx-b");
    await session.decide(REQUEST);
    await session.start();
    await delivered();

    expect(kinds(events)).not.toContain("answer-discarded");
  });
});
