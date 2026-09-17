import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthorizationTransportError, type AuthorizationTransport } from "@ricardoqmd/authz-core";

import { createHttpTransport, type HttpTransportConfig, type HttpTransportDiagnostic } from "./index.js";

const BASE = "https://example.test/api";
const APP = "app-a";
const CTX = "ctx-a";
const REQUEST = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1"] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function answering(respond: (url: string) => Response | Promise<Response>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => respond(String(input))) as typeof globalThis.fetch;
}

/** The right body for each route, with `over` spread into both. */
function good(over: Record<string, unknown> = {}) {
  return (url: string): Response =>
    json(
      url.endsWith("/decisions")
        ? { app: APP, contextId: CTX, decisions: [], ...over }
        : { app: APP, contextId: CTX, permissions: [], ...over },
    );
}

async function delivered(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function heard(over: Partial<HttpTransportConfig>) {
  const events: HttpTransportDiagnostic[] = [];
  const transport = createHttpTransport({
    baseUrl: BASE,
    getToken: () => "tok-123",
    onDiagnostic: (event) => {
      events.push(event);
    },
    ...over,
  });
  return { transport, events };
}

/** Both calls, each settled, as what they resolved or rejected with. */
async function both(transport: AuthorizationTransport) {
  const settle = (promise: Promise<unknown>) =>
    promise.then(
      (value) => ({ value }),
      (error: unknown) =>
        error instanceof AuthorizationTransportError
          ? { kind: error.kind, message: error.message, name: error.name }
          : { thrown: String(error) },
    );
  return [await settle(transport.fetchPermissions(APP)), await settle(transport.fetchDecisions(APP, REQUEST))];
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
      createHttpTransport({
        baseUrl: BASE,
        getToken: () => null,
        onDiagnostic: value as unknown as HttpTransportConfig["onDiagnostic"],
      });

    expect(build).toThrow(RangeError);
    expect(build).toThrow(`onDiagnostic must be a function, received ${type}`);
    expect(() => build()).not.toThrow(/field-secret/);
  });

  it("refuses it before any path function is called", () => {
    const probed: string[] = [];

    expect(() =>
      createHttpTransport({
        baseUrl: BASE,
        getToken: () => null,
        onDiagnostic: 42 as unknown as HttpTransportConfig["onDiagnostic"],
        paths: { permissions: (app) => (probed.push(app), `/p/${app}`) },
      }),
    ).toThrow(RangeError);
    expect(probed).toEqual([]);
  });

  it("accepts it omitted and given as undefined", () => {
    expect(() => createHttpTransport({ baseUrl: BASE, getToken: () => null })).not.toThrow();
    expect(() => createHttpTransport({ baseUrl: BASE, getToken: () => null, onDiagnostic: undefined })).not.toThrow();
  });
});

describe("call-failed, once per call, with the rule that refused it", () => {
  it.each<[string, Partial<HttpTransportConfig>, HttpTransportDiagnostic["reason"]]>([
    ["the request does not complete", { fetch: answering(() => Promise.reject(new TypeError("network"))) }, "no-response"],
    ["the token cannot be obtained", { fetch: answering(good()), getToken: () => { throw new Error("no token"); } }, "no-response"],
    ["the status is 500", { fetch: answering(() => json({}, 500)) }, "status"],
    ["the status is 403", { fetch: answering(() => json({}, 403)) }, "status"],
    ["the status is 404 and classifyError throws", {
      fetch: answering(() => json({}, 404)),
      classifyError: () => { throw new Error("x"); },
    }, "status"],
    ["the body is not JSON", { fetch: answering(() => new Response("<html>", { status: 200 })) }, "not-json"],
    ["the body is an array", { fetch: answering(() => json([])) }, "not-an-object"],
    ["the body is null", { fetch: answering(() => json(null)) }, "not-an-object"],
    ["the app is missing", { fetch: answering(good({ app: undefined })) }, "no-app"],
    ["the app is not a string", { fetch: answering(good({ app: 7 })) }, "no-app"],
    ["the list is missing", { fetch: answering(good({ permissions: undefined, decisions: undefined })) }, "no-list"],
    ["the list is an object", { fetch: answering(good({ permissions: {}, decisions: {} })) }, "no-list"],
    ["the context echo is missing", { contextId: CTX, contextHeader: "X-Context-Id", fetch: answering(good({ contextId: undefined })) }, "no-context-echo"],
    ["the context echo is not a string", { contextId: CTX, contextHeader: "X-Context-Id", fetch: answering(good({ contextId: 1 })) }, "no-context-echo"],
    ["the configured echo field is missing", {
      contextId: CTX, contextHeader: "X-Context-Id", contextField: "contractId", fetch: answering(good()),
    }, "no-context-echo"],
    ["the context echo is another context", { contextId: CTX, contextHeader: "X-Context-Id", fetch: answering(good({ contextId: "ctx-b" })) }, "other-context"],
    ["the configured echo field is another context", {
      contextId: CTX, contextHeader: "X-Context-Id", contextField: "contractId", fetch: answering(good({ contractId: "ctx-b" })),
    }, "other-context"],
  ])("when %s — and the calls reject exactly as they do without a callback", async (_label, over, reason) => {
    const { transport, events } = heard(over);
    const quiet = createHttpTransport({ baseUrl: BASE, getToken: () => "tok-123", ...over });

    const [loud, silent] = [await both(transport), await both(quiet)];
    await delivered();

    expect(loud).toEqual(silent);
    expect(loud.every((outcome) => "kind" in outcome)).toBe(true);
    expect(events).toEqual([
      { kind: "call-failed", operation: "permissions", reason },
      { kind: "call-failed", operation: "decisions", reason },
    ]);
  });

  it.each<[string, Partial<HttpTransportConfig>]>([
    ["calls that answer", { fetch: answering(good()) }],
    ["calls that echo the context", { contextId: CTX, contextHeader: "X-Context-Id", fetch: answering(good()) }],
    ["calls that echo the context under the configured field", {
      contextId: CTX, contextHeader: "X-Context-Id", contextField: "contractId", fetch: answering(good({ contractId: CTX })),
    }],
    ["calls that answer, with a classifyError given", { fetch: answering(good()), classifyError: () => "NO_ACCESS_IN_APP" }],
  ])("is not raised for %s", async (_label, over) => {
    const { transport, events } = heard(over);

    await both(transport);
    await delivered();

    expect(events).toEqual([]);
  });

  it("is not raised for a path or an application id refused at call time, which reject with a RangeError", async () => {
    const { transport, events } = heard({
      fetch: answering(good()),
      paths: { permissions: (app) => (app === "probe" ? "/p" : "p"), decisions: (app) => (app === "probe" ? "/d" : "d") },
    });

    await expect(transport.fetchPermissions(APP)).rejects.toThrow(RangeError);
    await expect(transport.fetchDecisions(APP, REQUEST)).rejects.toThrow(RangeError);
    await expect(transport.fetchPermissions("a/b")).rejects.toThrow(RangeError);
    await delivered();

    expect(events).toEqual([]);
  });

  it("is not raised for an error the consumer's fetch rejects with that is itself an AuthorizationTransportError", async () => {
    const own = new AuthorizationTransportError("NO_ACCESS_IN_APP", "the consumer's own");
    const { transport, events } = heard({ fetch: answering(() => Promise.reject(own)) });

    const outcomes = await both(transport);
    await delivered();

    expect(outcomes.map((outcome) => ("message" in outcome ? outcome.message : ""))).toEqual([
      "/me/apps/app-a/permissions: the request did not complete",
      "/me/apps/app-a/decisions: the request did not complete",
    ]);
    expect(events.map((event) => event.reason)).toEqual(["no-response", "no-response"]);
  });
});

describe("an event is handed over in a task of its own", () => {
  it("does not run before the call that raised it has settled, and runs after", async () => {
    const { transport, events } = heard({ fetch: answering(() => json({}, 500)) });

    await expect(transport.fetchPermissions(APP)).rejects.toThrow(AuthorizationTransportError);
    const whenSettled = events.length;
    await delivered();

    expect([whenSettled, events.length]).toEqual([0, 1]);
  });

  it("schedules nothing when no callback is given, and one task per event when one is", async () => {
    vi.useFakeTimers();
    const over = { baseUrl: BASE, getToken: () => "tok", fetch: answering(() => json({}, 500)) };
    const run = async (transport: AuthorizationTransport) => {
      await both(transport);
      return vi.getTimerCount();
    };

    const without = await run(createHttpTransport(over));
    const withOne = await run(createHttpTransport({ ...over, onDiagnostic: () => undefined }));

    expect([without, withOne]).toEqual([0, 2]);
  });

  it("what the callback throws does not leave the task it runs in", async () => {
    vi.useFakeTimers();
    const { transport } = heard({
      fetch: answering(() => json({}, 500)),
      onDiagnostic: () => {
        throw new Error("the consumer's callback is broken");
      },
    });

    await expect(transport.fetchPermissions(APP)).rejects.toThrow(AuthorizationTransportError);

    expect(vi.getTimerCount()).toBe(1);
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it("a callback that throws changes nothing the transport does, and every later event still arrives", async () => {
    const thrown: HttpTransportDiagnostic[] = [];
    const over = { baseUrl: BASE, getToken: () => "tok", fetch: answering(() => json({}, 500)) };
    const quiet = createHttpTransport(over);
    const loud = createHttpTransport({
      ...over,
      onDiagnostic: (event) => {
        thrown.push(event);
        throw new Error("the consumer's callback is broken");
      },
    });

    const a = await both(quiet);
    const b = await both(loud);
    await delivered();
    const c = await both(loud);
    await delivered();

    expect([b, c]).toEqual([a, a]);
    expect(thrown).toHaveLength(4);
  });

  it("each event is a frozen object holding its kind and the fields its kind declares", async () => {
    const { transport, events } = heard({ fetch: answering(() => json({}, 500)) });

    await both(transport);
    await delivered();

    expect(events.map((event) => Object.isFrozen(event))).toEqual([true, true]);
    expect(events.map((event) => Object.keys(event).sort())).toEqual([
      ["kind", "operation", "reason"],
      ["kind", "operation", "reason"],
    ]);
  });
});

describe("an event carries nothing read out of a response, and nothing the request carried", () => {
  it("not the token, the context, a header, the route, the status or the body", async () => {
    const SECRET = "secret-7f3a";
    const events: HttpTransportDiagnostic[] = [];
    const bodies: (() => Response)[] = [
      () => json({ error: SECRET }, 418),
      () => new Response(`${SECRET} not json`, { status: 200, statusText: SECRET }),
      () => json([SECRET]),
      () => json({ app: SECRET, contextId: SECRET, permissions: SECRET, decisions: SECRET }),
      () => json({ app: APP, contextId: `${SECRET}-other`, permissions: [], decisions: [] }),
      () => json({ app: APP, permissions: [], decisions: [] }),
    ];
    for (const body of bodies) {
      const transport = createHttpTransport({
        baseUrl: `${BASE}/${SECRET}`,
        getToken: () => SECRET,
        contextId: SECRET,
        contextHeader: `X-${SECRET}`,
        contextField: SECRET,
        classifyError: () => undefined,
        paths: { permissions: (app) => `/${SECRET}/${app}`, decisions: (app) => `/${SECRET}/${app}/d` },
        fetch: answering(body),
        onDiagnostic: (event) => events.push(event),
      });
      await both(transport);
    }
    await delivered();

    expect(events).toHaveLength(bodies.length * 2);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain("418");
  });
});
