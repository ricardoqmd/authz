import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthorizationSession,
  type AuthorizationDiagnostic,
  type AuthorizationSession,
  type AuthorizationSessionOptions,
} from "./session.js";
import {
  AuthorizationTransportError,
  type AuthorizationTransport,
  type DecisionRequest,
  type DecisionSet,
  type PermissionMenu,
} from "./transport.js";

const APP = "app-a";

const REQUEST: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1"] };

const MENU: PermissionMenu = { app: APP, permissions: [{ action: "read", effect: "PERMIT" }] };

function answering(request: DecisionRequest): DecisionSet {
  const decisions = [];
  for (const action of request.actions) {
    for (const resourceId of request.resourceIds) {
      decisions.push({ action, resourceId, effect: "PERMIT" as const });
    }
  }
  return { app: APP, decisions };
}

function transport(over: Partial<AuthorizationTransport> = {}): AuthorizationTransport {
  return {
    fetchPermissions: over.fetchPermissions ?? (async () => MENU),
    fetchDecisions: over.fetchDecisions ?? (async (_app, request) => answering(request)),
  };
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

/** Lets every task already scheduled run, and every event already raised arrive. */
async function delivered(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function heard(over: Partial<AuthorizationTransport> = {}, options: Partial<AuthorizationSessionOptions> = {}) {
  const events: AuthorizationDiagnostic[] = [];
  const session = createAuthorizationSession({
    app: APP,
    transport: transport(over),
    maxPairsPerRequest: 100,
    onDiagnostic: (event) => {
      events.push(event);
    },
    ...options,
  });
  return { session, events };
}

async function started(over: Partial<AuthorizationTransport> = {}, options: Partial<AuthorizationSessionOptions> = {}) {
  const built = heard(over, options);
  await built.session.start();
  await delivered();
  built.events.length = 0;
  return built;
}

function kinds(events: readonly AuthorizationDiagnostic[]): string[] {
  return events.map((event) => event.kind);
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
      createAuthorizationSession({
        app: APP,
        transport: transport(),
        maxPairsPerRequest: 100,
        onDiagnostic: value as unknown as AuthorizationSessionOptions["onDiagnostic"],
      });

    expect(build).toThrow(RangeError);
    expect(build).toThrow(`onDiagnostic must be a function, received ${type}`);
    expect(() => build()).not.toThrow(/field-secret/);
  });

  it("accepts it omitted and given as undefined", () => {
    const options = { app: APP, transport: transport(), maxPairsPerRequest: 100 };

    expect(() => createAuthorizationSession(options)).not.toThrow();
    expect(() => createAuthorizationSession({ ...options, onDiagnostic: undefined })).not.toThrow();
  });
});

describe("an event is handed over in a task of its own", () => {
  it("does not run before the call that raised it has settled, and runs after", async () => {
    const { session, events } = await started();
    await session.decide(REQUEST);
    await delivered();
    events.length = 0;

    await session.decide(REQUEST);
    const whenSettled = events.length;
    await delivered();

    expect([whenSettled, kinds(events)]).toEqual([0, ["from-cache"]]);
  });

  it("schedules nothing when no callback is given, and one task per event when one is", async () => {
    vi.useFakeTimers();
    const run = async (session: AuthorizationSession) => {
      await session.start();
      await session.decide(REQUEST);
      await session.decide(REQUEST);
      return vi.getTimerCount();
    };

    const without = await run(
      createAuthorizationSession({ app: APP, transport: transport(), maxPairsPerRequest: 100 }),
    );
    const withOne = await run(heard().session);

    expect([without, withOne]).toEqual([0, 2]);
  });

  it("under fake timers, an event waits for the clock to be advanced like any other timer", async () => {
    vi.useFakeTimers();
    const { session, events } = heard();

    await session.start();
    const beforeAdvancing = events.length;
    vi.runAllTimers();

    expect([beforeAdvancing, kinds(events)]).toEqual([0, ["menu-requested"]]);
  });

  it("what the callback throws does not leave the task it runs in", async () => {
    vi.useFakeTimers();
    const session = createAuthorizationSession({
      app: APP,
      transport: transport(),
      maxPairsPerRequest: 100,
      onDiagnostic: () => {
        throw new Error("the consumer's callback is broken");
      },
    });

    await session.start();

    expect(vi.getTimerCount()).toBe(1);
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it("a callback that throws changes nothing the session does, and every later event still arrives", async () => {
    const thrown: AuthorizationDiagnostic[] = [];
    const quiet = createAuthorizationSession({ app: APP, transport: transport(), maxPairsPerRequest: 100 });
    const loud = createAuthorizationSession({
      app: APP,
      transport: transport(),
      maxPairsPerRequest: 100,
      onDiagnostic: (event) => {
        thrown.push(event);
        throw new Error("the consumer's callback is broken");
      },
    });
    const observe = async (session: AuthorizationSession) => {
      const states: string[] = [];
      session.subscribe((state) => states.push(state.status));
      await session.start();
      await delivered();
      const first = await session.decide(REQUEST);
      await delivered();
      const second = await session.decide(REQUEST);
      await delivered();
      return { states, first, second, state: session.getState() };
    };

    const [a, b] = [await observe(quiet), await observe(loud)];

    expect(b).toEqual(a);
    expect(kinds(thrown)).toEqual(["menu-requested", "from-cache"]);
  });

  it("each event is a frozen object holding its kind and the fields its kind declares", async () => {
    const { session, events } = heard();

    await session.start();
    await session.decide(REQUEST);
    await session.decide(REQUEST);
    await delivered();

    expect(events.map((event) => Object.isFrozen(event))).toEqual([true, true]);
    expect(events.map((event) => Object.getPrototypeOf(event) === Object.prototype)).toEqual([true, true]);
    expect(events).toEqual([
      { kind: "menu-requested", restart: false },
      { kind: "from-cache", resourceType: "orders", pairs: 1 },
    ]);
  });
});

describe("an event carries no value read out of an answer", () => {
  it("not a message, an app, a field or an element of any answer, whatever the answers hold", async () => {
    const SECRET = "answer-secret";
    const rejections = [
      new AuthorizationTransportError("UNAVAILABLE", `${SECRET} in a message`),
      new Error(`${SECRET} in a message`),
      Object.assign(new Error("x"), { detail: SECRET }),
    ];
    const answers: unknown[] = [
      { app: SECRET, decisions: [] },
      { app: APP, decisions: [{ action: SECRET, resourceId: SECRET, effect: SECRET }] },
      { app: APP, decisions: [() => SECRET] },
      { app: APP, decisions: new Set([SECRET]) },
      null,
      { [SECRET]: SECRET },
    ];
    const menus: unknown[] = [
      { app: SECRET, permissions: [] },
      { app: APP, permissions: [{ action: 1, effect: SECRET }] },
      { app: APP, permissions: [() => SECRET] },
      { app: APP, permissions: SECRET },
      SECRET,
    ];
    const events: AuthorizationDiagnostic[] = [];
    const onDiagnostic = (event: AuthorizationDiagnostic) => {
      events.push(event);
    };

    for (const menu of [...menus, ...rejections]) {
      const session = createAuthorizationSession({
        app: APP,
        maxPairsPerRequest: 100,
        onDiagnostic,
        transport: transport({
          fetchPermissions: async () => {
            if (menu instanceof Error) throw menu;
            return menu as PermissionMenu;
          },
        }),
      });
      await session.start();
    }
    for (const answer of [...answers, ...rejections]) {
      const session = createAuthorizationSession({
        app: APP,
        maxPairsPerRequest: 1,
        onDiagnostic,
        transport: transport({
          fetchDecisions: async (_app, request) => {
            if (answer instanceof Error) throw answer;
            return request.resourceIds[0] === "r-1" ? (answer as DecisionSet) : answering(request);
          },
        }),
      });
      await session.start();
      await session.decide({ resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] });
    }
    await delivered();

    expect(new Set(kinds(events))).toEqual(
      new Set(["menu-requested", "menu-unavailable", "chunk-failed", "call-emptied"]),
    );
    expect(JSON.stringify(events)).not.toContain(SECRET);
    for (const event of events) {
      for (const value of Object.values(event)) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
  });
});

describe("menu-requested", () => {
  it("is raised each time start() asks for the menu, restart false the first time and true after", async () => {
    const { session, events } = heard();

    await session.start();
    await session.start();
    await session.start();
    await delivered();

    expect(events).toEqual([
      { kind: "menu-requested", restart: false },
      { kind: "menu-requested", restart: true },
      { kind: "menu-requested", restart: true },
    ]);
  });

  it("is raised with restart false once per session, so sessions built for one screen are counted", async () => {
    const events: AuthorizationDiagnostic[] = [];
    for (let render = 0; render < 6; render += 1) {
      const session = createAuthorizationSession({
        app: APP,
        transport: transport(),
        maxPairsPerRequest: 100,
        onDiagnostic: (event) => events.push(event),
      });
      await session.start();
    }
    await delivered();

    expect(events.filter((event) => event.kind === "menu-requested" && !event.restart)).toHaveLength(6);
  });

  it("is not raised by decide(), close(), or a start() on a closed session", async () => {
    const { session, events } = await started();

    await session.decide(REQUEST);
    session.close();
    await session.start();
    await delivered();

    expect(kinds(events)).not.toContain("menu-requested");
  });
});

describe("menu-unavailable", () => {
  const grows = () => {
    const list: unknown[] = [];
    list.push({
      get action() {
        list.push({ action: "delete", effect: "DENY" });
        return "read";
      },
      effect: "PERMIT",
    });
    return { app: APP, permissions: list };
  };

  it.each<[string, () => Promise<unknown>, string]>([
    ["asking for the menu rejects", async () => Promise.reject(new Error("down")), "rejected"],
    ["asking for the menu throws before returning", () => {
      throw new Error("down");
    }, "rejected"],
    ["it rejects UNAVAILABLE", async () => Promise.reject(new AuthorizationTransportError("UNAVAILABLE")), "rejected"],
    ["the answer is null", async () => null, "not-a-menu"],
    ["the answer has no permissions", async () => ({ app: APP }), "not-a-menu"],
    ["the permissions are a Set", async () => ({ app: APP, permissions: new Set() }), "not-a-menu"],
    ["the answer is labelled with another app", async () => ({ app: "app-b", permissions: [] }), "other-app"],
    ["an entry is a function", async () => ({ app: APP, permissions: [() => undefined] }), "unreadable-entry"],
    ["an entry's action throws when read", async () => ({
      app: APP,
      permissions: [{ get action() { throw new Error("x"); }, effect: "PERMIT" }],
    }), "unreadable-entry"],
    ["the list gains an entry while it is read", async () => grows(), "unreadable-entry"],
    ["no entry names its action", async () => ({ app: APP, permissions: [{ action: 1, effect: "PERMIT" }] }), "no-action-named"],
  ])("when %s, with that reason, beside UNAVAILABLE", async (_label, fetchPermissions, reason) => {
    const { session, events } = heard({ fetchPermissions: fetchPermissions as AuthorizationTransport["fetchPermissions"] });

    await session.start();
    await delivered();

    expect([session.getState().status, events]).toEqual([
      "UNAVAILABLE",
      [{ kind: "menu-requested", restart: false }, { kind: "menu-unavailable", reason }],
    ]);
  });

  it.each<[string, () => Promise<unknown>, string]>([
    ["a menu", async () => MENU, "READY"],
    ["an empty menu", async () => ({ app: APP, permissions: [] }), "READY"],
    ["a menu with one entry that names no action beside one that does", async () => ({
      app: APP,
      permissions: [{ action: 1, effect: "PERMIT" }, { action: "read", effect: "PERMIT" }],
    }), "READY"],
    ["a NO_ACCESS_IN_APP rejection", async () => Promise.reject(new AuthorizationTransportError("NO_ACCESS_IN_APP")), "NO_ACCESS_IN_APP"],
  ])("is not raised for %s", async (_label, fetchPermissions, status) => {
    const { session, events } = heard({ fetchPermissions: fetchPermissions as AuthorizationTransport["fetchPermissions"] });

    await session.start();
    await delivered();

    expect([session.getState().status, kinds(events)]).toEqual([status, ["menu-requested"]]);
  });
});

describe("chunk-failed", () => {
  const TWO_CHUNKS: DecisionRequest = { resourceType: "orders", actions: ["read", "edit"], resourceIds: ["r-1", "r-2"] };

  it.each<[string, (request: DecisionRequest) => Promise<unknown>, string]>([
    ["asking for it rejects", async () => Promise.reject(new Error("down")), "rejected"],
    ["its answer is null", async () => null, "no-list"],
    ["its answer has no decisions", async () => ({ app: APP }), "no-list"],
    ["its answer is labelled with another app", async (request) => ({ ...answering(request), app: "app-b" }), "other-app"],
  ])("is raised once, for the chunk alone, when %s", async (_label, failing, reason) => {
    const { session, events } = await started(
      {
        fetchDecisions: async (_app, request) =>
          (request.resourceIds[0] === "r-2" ? failing(request) : answering(request)) as Promise<DecisionSet>,
      },
      { maxPairsPerRequest: 2 },
    );

    const decisions = await session.decide(TWO_CHUNKS);
    await delivered();

    expect([decisions.length, events]).toEqual([2, [{ kind: "chunk-failed", reason, resourceType: "orders", pairs: 2 }]]);
  });

  it("is not raised when every chunk answers, however little it answers", async () => {
    const { session, events } = await started(
      { fetchDecisions: async () => ({ app: APP, decisions: [] }) },
      { maxPairsPerRequest: 2 },
    );

    await session.decide(TWO_CHUNKS);
    await delivered();

    expect(events).toEqual([]);
  });
});

describe("call-emptied", () => {
  const PAIRS: DecisionRequest = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2", "r-3"] };

  it.each<[string, () => unknown]>([
    ["an element is a function", () => ({ app: APP, decisions: [() => undefined] })],
    ["an element's action throws when read", () => ({
      app: APP,
      decisions: [{ get action() { throw new Error("x"); }, resourceId: "r-1", effect: "PERMIT" }],
    })],
    ["decisions is a Set", () => ({ app: APP, decisions: new Set() })],
    ["the answer throws when read", () => ({ get app() { throw new Error("x"); }, decisions: [] })],
    ["the list gains an element while it is read", () => {
      const list: unknown[] = [];
      list.push({
        get action() {
          list.push({ action: "read", resourceId: "r-2", effect: "DENY" });
          return "read";
        },
        resourceId: "r-1",
        effect: "PERMIT",
      });
      return { app: APP, decisions: list };
    }],
  ])("is raised when %s, and the call resolves with the empty list", async (_label, answer) => {
    const { session, events } = await started({ fetchDecisions: async () => answer() as DecisionSet });

    const decisions = await session.decide(PAIRS);
    await delivered();

    expect([decisions, events]).toEqual([[], [{ kind: "call-emptied", resourceType: "orders", pairs: 3 }]]);
  });

  it("is not raised when an element names no pair and is dropped", async () => {
    const { session, events } = await started({
      fetchDecisions: async () => ({ app: APP, decisions: [null, { action: 1 }, { action: "read", resourceId: "r-1", effect: "PERMIT" }] }) as unknown as DecisionSet,
    });

    const decisions = await session.decide(PAIRS);
    await delivered();

    expect([decisions.length, events]).toEqual([1, []]);
  });
});

describe("answer-discarded", () => {
  it.each([
    ["resolves", (parked: ReturnType<typeof deferred<PermissionMenu>>) => parked.resolve(MENU)],
    ["rejects", (parked: ReturnType<typeof deferred<PermissionMenu>>) => parked.reject(new Error("down"))],
  ])("is raised for a menu that %s after a later start()", async (_label, settle) => {
    const parked = deferred<PermissionMenu>();
    let call = 0;
    const { session, events } = heard({
      fetchPermissions: () => (call++ === 0 ? parked.promise : Promise.resolve(MENU)),
    });

    const first = session.start();
    await session.start();
    settle(parked);
    await first;
    await delivered();

    expect(kinds(events)).toEqual(["menu-requested", "menu-requested", "answer-discarded"]);
    expect(events[2]).toEqual({ kind: "answer-discarded", operation: "start" });
  });

  it("is raised for a menu that arrives after close()", async () => {
    const parked = deferred<PermissionMenu>();
    const { session, events } = heard({ fetchPermissions: () => parked.promise });

    const first = session.start();
    session.close();
    parked.resolve(MENU);
    await first;
    await delivered();

    expect(events).toEqual([{ kind: "menu-requested", restart: false }, { kind: "answer-discarded", operation: "start" }]);
  });

  it("is raised for decisions that arrive after close(), and the call resolves with the empty list", async () => {
    const parked = deferred<DecisionSet>();
    const { session, events } = await started({ fetchDecisions: () => parked.promise });

    const deciding = session.decide(REQUEST);
    session.close();
    parked.resolve(answering(REQUEST));
    const decisions = await deciding;
    await delivered();

    expect([decisions, events]).toEqual([[], [{ kind: "answer-discarded", operation: "decide" }]]);
  });

  it("is not raised for answers that arrive in time", async () => {
    const { session, events } = await started();

    await session.decide(REQUEST);
    await session.start();
    await delivered();

    expect(kinds(events)).not.toContain("answer-discarded");
  });
});

describe("from-cache", () => {
  it("is raised when every pair of the request is cached, and the transport is not asked", async () => {
    const asked: DecisionRequest[] = [];
    const { session, events } = await started({
      fetchDecisions: async (_app, request) => {
        asked.push(request);
        return answering(request);
      },
    });
    const request = { resourceType: "orders", actions: ["read", "edit"], resourceIds: ["r-1"] };

    await session.decide(request);
    await session.decide(request);
    await delivered();

    expect([asked.length, events]).toEqual([1, [{ kind: "from-cache", resourceType: "orders", pairs: 2 }]]);
  });

  it("is not raised for the first call, nor for a call that finds only some of its pairs cached", async () => {
    const { session, events } = await started();

    await session.decide(REQUEST);
    await session.decide({ resourceType: "orders", actions: ["read"], resourceIds: ["r-1", "r-2"] });
    await delivered();

    expect(events).toEqual([]);
  });
});
