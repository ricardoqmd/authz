import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationTransportError,
  type AuthorizationTransport,
  type TransportErrorKind,
} from "@ricardoqmd/authz-core";

import { createHttpTransport, type HttpTransportConfig } from "./index.js";

const BASE = "https://example.test/api";
const APP = "app-a";
const CTX = "ctx-a";
const HEADER = "X-Context-Id";

/** A `fetch` double that records what it was called with and answers what the test dictates. */
function stub(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchDouble = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return answer(url, init ?? {});
  });
  return { calls, fetchDouble: fetchDouble as unknown as typeof globalThis.fetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The default build: no context pair, which is the mode a consumer without contexts uses. */
function transport(over: Partial<HttpTransportConfig> = {}): AuthorizationTransport {
  return createHttpTransport({ baseUrl: BASE, getToken: () => "tok-123", ...over });
}

/** The build with the optional pair supplied. */
function withContext(over: Partial<HttpTransportConfig> = {}): AuthorizationTransport {
  return transport({ contextId: CTX, contextHeader: HEADER, ...over });
}

/** The headers of a recorded call, as a plain record. */
function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

/** Answers the right shape per route, for the tests that exercise both. */
function byRoute(extra: Record<string, unknown> = {}) {
  return (url: string): Response =>
    json(url.endsWith("/decisions") ? { ...SET, ...extra } : { ...MENU, ...extra });
}

const MENU = { app: APP, permissions: [{ action: "read", effect: "PERMIT" }] };
const SET = { app: APP, decisions: [] };
const REQUEST = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1"] };

/* 1 — the optional context pair, and its three modes ---------------------- */

describe("the context pair is optional, and there are exactly three modes", () => {
  it("NEITHER: no context header is sent, and no echo is required", async () => {
    const s = stub(byRoute());
    const t = transport({ fetch: s.fetchDouble });

    // A backend that has never heard of contexts. The body carries no contextId at all.
    await t.fetchPermissions(APP);
    await t.fetchDecisions(APP, REQUEST);

    for (const call of s.calls) {
      expect(headersOf(call.init)[HEADER]).toBeUndefined();
      expect(Object.keys(headersOf(call.init)).some((h) => /context/i.test(h))).toBe(false);
    }
  });

  it("NEITHER: a body that DOES carry a contextId is not rejected for it", async () => {
    const s = stub(() => json({ ...MENU, contextId: "whatever" }));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).resolves.toMatchObject({ app: APP });
  });

  it("BOTH: the header carries the id, under the configured name", async () => {
    const s = stub(byRoute({ contextId: CTX }));
    const t = withContext({ fetch: s.fetchDouble });

    await t.fetchPermissions(APP);
    await t.fetchDecisions(APP, REQUEST);

    expect(s.calls).toHaveLength(2);
    for (const call of s.calls) {
      expect(headersOf(call.init)[HEADER]).toBe(CTX);
    }
  });

  it("BOTH: the header NAME comes from configuration, not from this package", async () => {
    const s = stub(() => json({ ...MENU, contextId: CTX }));
    const t = withContext({ fetch: s.fetchDouble, contextHeader: "X-Something-Else" });

    await t.fetchPermissions(APP);

    expect(headersOf(s.calls[0]!.init)["X-Something-Else"]).toBe(CTX);
    expect(headersOf(s.calls[0]!.init)[HEADER]).toBeUndefined();
  });

  it("ONE WITHOUT THE OTHER: an id with nowhere to send it is a RangeError at construction", () => {
    expect(() => transport({ contextId: CTX })).toThrow(RangeError);
    expect(() => transport({ contextId: CTX })).toThrow(/contextHeader is required/);
  });

  it("ONE WITHOUT THE OTHER: a header with nothing to put in it is a RangeError too", () => {
    expect(() => transport({ contextHeader: HEADER })).toThrow(RangeError);
    expect(() => transport({ contextHeader: HEADER })).toThrow(/contextId is required/);
  });
});

/* 2 — the echo check, which moved here from the core ---------------------- */

describe("a response whose context does not echo the one sent is rejected LOUDLY", () => {
  it("rejects a mismatched echo on the permissions route", async () => {
    const s = stub(() => json({ ...MENU, contextId: "ctx-b" }));
    const t = withContext({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).rejects.toBeInstanceOf(AuthorizationTransportError);
  });

  it("rejects a mismatched echo on the decisions route", async () => {
    const s = stub(() => json({ ...SET, contextId: "ctx-b" }));
    const t = withContext({ fetch: s.fetchDouble });

    await expect(t.fetchDecisions(APP, REQUEST)).rejects.toThrow(/does not echo/);
  });

  it("rejects a MISSING contextId when one was sent, naming the route and the field", async () => {
    const s = stub(() => json(MENU));
    const t = withContext({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(
      /\/me\/apps\/app-a\/permissions: the response is missing the "contextId" field/,
    );
  });

  it("carries neither the body, nor the token, nor the header value into the message", async () => {
    // The configured id is distinctive on purpose: with the shared `CTX` the third assertion
    // below would be asserting the absence of a string this test never puts anywhere.
    const configured = "ctx-configured-secret";
    const s = stub(() => json({ ...MENU, contextId: "ctx-secret" }));
    const t = transport({
      fetch: s.fetchDouble,
      getToken: () => "tok-secret",
      contextId: configured,
      contextHeader: HEADER,
    });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("ctx-secret") as unknown as string,
      }) as unknown as Error,
    );
    await expect(t.fetchPermissions(APP)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("tok-secret") as unknown as string,
      }) as unknown as Error,
    );
    // The third thing the name promises, which until now it did not measure. The header value is
    // the consumer's own configuration rather than server text, so the leak is the mildest of the
    // three — but a test whose name lists three things and checks two is worse than one that lists
    // two, because the missing one is the one nobody looks for again.
    await expect(t.fetchPermissions(APP)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(configured) as unknown as string,
      }) as unknown as Error,
    );
  });

  it("accepts a matching echo and passes through what the BODY says", async () => {
    const s = stub(() => json({ app: APP, contextId: CTX, permissions: [] }));
    const t = withContext({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).resolves.toEqual({ app: APP, permissions: [] });
  });
});

/* 3 — the app echo, which did NOT move ------------------------------------ */

describe("the app echo stays here, and is required in every mode", () => {
  it("rejects a body with no app, with the pair configured", async () => {
    const s = stub(() => json({ contextId: CTX, permissions: [] }));
    const t = withContext({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(/missing the "app" field/);
  });

  it("rejects a body with no app, with no pair configured either", async () => {
    const s = stub(() => json({ permissions: [] }));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(/missing the "app" field/);
  });

  it("passes through what the BODY says, not what was asked", async () => {
    const s = stub(() => json({ app: "app-b", permissions: [] }));
    const t = transport({ fetch: s.fetchDouble });

    // Filling it in from the request would make the core's guard tautological.
    await expect(t.fetchPermissions(APP)).resolves.toEqual({ app: "app-b", permissions: [] });
  });

  // The same pair on the decisions route. Both routes read `app` out of the body, and both need
  // their own witness: the checks are two separate call sites, and a test that exercises one says
  // nothing about the other.
  //
  // This is the route where getting it wrong is worst. The core discards a whole response whose
  // `app` does not match what it asked about. If this adapter filled the field in from the request
  // instead of reading it, that check could never fail — and a decision point answering about a
  // DIFFERENT application would pass the filter, get merged into the decision set, get cached and
  // get served as if it were this application's.

  it("rejects a JSON body that is not an object", async () => {
    // A body that parses but is an array, a string or a number is a broken adapter on the other
    // side, and the package never guesses a shape. Without this the value would be indexed as a
    // record and every field would read undefined — which surfaces as "missing app" and points the
    // reader at the wrong defect.
    const s = stub(() => json([{ app: APP, permissions: [] }]));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(/is not an object/);
  });

  // The two remaining sub-clauses of the same check, each with its own witness. Both fail closed
  // on their own — what a missing clause costs is the diagnosis, not the denial — and a rejection
  // that names the wrong defect sends the reader to the wrong file.

  it("rejects a null body, which typeof alone calls an object", async () => {
    // `typeof null === "object"`, so the null clause is the only thing standing between a null body
    // and a field read on null. Without it the failure is a TypeError from somewhere below, and
    // nothing in it says the body was the problem.
    const s = stub(() => json(null));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(/is not an object/);
  });

  it("rejects a body that parses to a string, which is neither object nor array", async () => {
    // The typeof clause. A JSON string or number parses fine and is not an array, so without it
    // every field reads undefined and the rejection becomes "missing the app field" — a true
    // sentence about a body that never had fields at all.
    const s = stub(() => json("READY"));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(/is not an object/);
  });

  it("rejects a permissions field that is not an array", async () => {
    // Not the same as a missing field, and it matters which screen the consumer ends up on: a menu
    // that parsed but is not a list must be UNAVAILABLE — "no answer was obtained" — and never
    // READY with an empty menu, which reads as "you may enter and may do nothing". Those are the
    // two screens the core's state type exists to keep apart, and the rejection has to happen here
    // because the core trusts the shape this adapter hands it.
    const s = stub(() => json({ app: APP, permissions: { read: true } }));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(/"permissions" array/);
  });

  it("rejects a decisions field that is not an array", async () => {
    const s = stub(() => json({ app: APP, decisions: "none" }));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchDecisions(APP, REQUEST)).rejects.toThrow(/"decisions" array/);
  });

  it("rejects a decision set with no app, naming the field and the route", async () => {
    const s = stub(() => json({ decisions: [] }));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchDecisions(APP, REQUEST)).rejects.toThrow(/missing the "app" field/);
    await expect(t.fetchDecisions(APP, REQUEST)).rejects.toThrow(/decisions/);
  });

  it("decisions pass through what the BODY says, not what was asked", async () => {
    const s = stub(() => json({ app: "app-b", decisions: [] }));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchDecisions(APP, REQUEST)).resolves.toEqual({ app: "app-b", decisions: [] });
  });
});

/* 4 — the Authorization header -------------------------------------------- */

describe("the Authorization header", () => {
  it("is present when getToken yields a token", async () => {
    const s = stub(() => json(MENU));
    await transport({ fetch: s.fetchDouble }).fetchPermissions(APP);
    expect(headersOf(s.calls[0]!.init).Authorization).toBe("Bearer tok-123");
  });

  it("is absent ENTIRELY when getToken yields null", async () => {
    const s = stub(() => json(MENU));
    await transport({ fetch: s.fetchDouble, getToken: () => null }).fetchPermissions(APP);
    expect(headersOf(s.calls[0]!.init).Authorization).toBeUndefined();
  });

  it("is absent when getToken yields an EMPTY STRING, not just null", async () => {
    const s = stub(() => json(MENU));
    await transport({ fetch: s.fetchDouble, getToken: () => "" }).fetchPermissions(APP);
    expect(headersOf(s.calls[0]!.init).Authorization).toBeUndefined();
  });

  it("awaits an async getToken", async () => {
    const s = stub(() => json(MENU));
    await transport({
      fetch: s.fetchDouble,
      getToken: async () => "tok-async",
    }).fetchPermissions(APP);
    expect(headersOf(s.calls[0]!.init).Authorization).toBe("Bearer tok-async");
  });
});

describe("the Accept header", () => {
  it("asks for JSON on every call", async () => {
    const s = stub(byRoute());
    const t = transport({ fetch: s.fetchDouble });
    await t.fetchPermissions(APP);
    await t.fetchDecisions(APP, REQUEST);
    for (const call of s.calls) {
      expect(headersOf(call.init).Accept).toBe("application/json");
    }
  });
});

describe("path segments are encoded", () => {
  it("an app id cannot escape its segment", async () => {
    const s = stub(() => json({ app: "a/b", permissions: [] }));
    await transport({ fetch: s.fetchDouble }).fetchPermissions("a/b");
    expect(s.calls[0]!.url).toBe(`${BASE}/me/apps/a%2Fb/permissions`);
  });
});

describe("the base URL is joined the same way with or without a trailing slash", () => {
  it("a trailing slash is fine, which is what the type declaration and the README both promise", async () => {
    // The promise is published twice — in the `baseUrl` doc comment, which travels in the `.d.ts`,
    // and in the README npm renders — and until now nothing measured it: removing the
    // normalisation left the whole suite green. It fails closed (a doubled slash is a 404, so
    // UNAVAILABLE), which is why this is a promise without a witness rather than an open guard.
    const withSlash = stub(() => json({ app: APP, permissions: [] }));
    const withoutSlash = stub(() => json({ app: APP, permissions: [] }));

    await transport({ baseUrl: `${BASE}/`, fetch: withSlash.fetchDouble }).fetchPermissions(APP);
    await transport({ baseUrl: BASE, fetch: withoutSlash.fetchDouble }).fetchPermissions(APP);

    expect(withSlash.calls[0]!.url).toBe(`${BASE}/me/apps/${APP}/permissions`);
    // "The same way" is the actual claim, so the two builds are compared to each other and not
    // only to a literal: a change that moved both would otherwise keep this test green.
    expect(withSlash.calls[0]!.url).toBe(withoutSlash.calls[0]!.url);
  });
});

/* 5 — error classification ------------------------------------------------ */

describe("error classification", () => {
  it("maps 403 to NO_ACCESS_IN_APP and everything else to UNAVAILABLE", async () => {
    const forbidden = stub(() => json({}, 403));
    await expect(
      transport({ fetch: forbidden.fetchDouble }).fetchPermissions(APP),
    ).rejects.toMatchObject({ kind: "NO_ACCESS_IN_APP" });

    const boom = stub(() => json({}, 500));
    await expect(
      transport({ fetch: boom.fetchDouble }).fetchPermissions(APP),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
  });

  it("maps a network rejection to UNAVAILABLE", async () => {
    const t = transport({
      fetch: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(t.fetchPermissions(APP)).rejects.toMatchObject({ kind: "UNAVAILABLE" });
  });

  it("maps a 2xx body that is not JSON to UNAVAILABLE", async () => {
    const s = stub(() => new Response("not json", { status: 200 }));
    await expect(
      transport({ fetch: s.fetchDouble }).fetchPermissions(APP),
    ).rejects.toThrow(/the body is not JSON/);
  });

  it("lets classifyError override, and sees the parsed body", async () => {
    const seen: unknown[] = [];
    const s = stub(() => json({ code: "SUSPENDED" }, 409));
    const t = transport({
      fetch: s.fetchDouble,
      classifyError: (status, body): TransportErrorKind | undefined => {
        seen.push({ status, body });
        return "NO_ACCESS_IN_APP";
      },
    });
    await expect(t.fetchPermissions(APP)).rejects.toMatchObject({ kind: "NO_ACCESS_IN_APP" });
    expect(seen).toEqual([{ status: 409, body: { code: "SUSPENDED" } }]);
  });

  it("falls through to the default when classifyError returns undefined", async () => {
    const s = stub(() => json({}, 403));
    const t = transport({ fetch: s.fetchDouble, classifyError: () => undefined });
    await expect(t.fetchPermissions(APP)).rejects.toMatchObject({ kind: "NO_ACCESS_IN_APP" });
  });

  it("a classifyError that THROWS does not escape, and carries nothing into the message", async () => {
    const s = stub(() => json({}, 403));
    const t = transport({
      fetch: s.fetchDouble,
      classifyError: () => {
        throw new Error("hook-secret");
      },
    });
    await expect(t.fetchPermissions(APP)).rejects.toMatchObject({ kind: "NO_ACCESS_IN_APP" });
    await expect(t.fetchPermissions(APP)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("hook-secret") as unknown as string,
      }) as unknown as Error,
    );
  });
});

describe("nothing from a response body reaches a thrown message", () => {
  it("does not leak what a REJECTED getToken threw", async () => {
    const s = stub(() => json(MENU));
    const t = transport({
      fetch: s.fetchDouble,
      getToken: () => {
        throw new Error("token-secret");
      },
    });
    await expect(t.fetchPermissions(APP)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("token-secret") as unknown as string,
      }) as unknown as Error,
    );
  });

  it("does not leak the body of a failed response", async () => {
    const s = stub(() => json({ detail: "body-secret" }, 500));
    await expect(transport({ fetch: s.fetchDouble }).fetchPermissions(APP)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("body-secret") as unknown as string,
      }) as unknown as Error,
    );
  });
});

/* 6 — the port ------------------------------------------------------------ */

describe("the port", () => {
  it("satisfies AuthorizationTransport with exactly two methods", () => {
    const t = transport();
    expect(typeof t.fetchPermissions).toBe("function");
    expect(typeof t.fetchDecisions).toBe("function");
    expect(Object.keys(t).sort()).toEqual(["fetchDecisions", "fetchPermissions"]);
  });

  it("defaults fetch to the global when none is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(MENU) as unknown as Response);
    try {
      await transport().fetchPermissions(APP);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("sends the request as the POST body on the decisions call", async () => {
    const s = stub(() => json(SET));
    await transport({ fetch: s.fetchDouble }).fetchDecisions(APP, REQUEST);
    expect(s.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(s.calls[0]!.init.body))).toEqual(REQUEST);
  });

  it("has no contexts route left", () => {
    expect((transport() as unknown as Record<string, unknown>).listContexts).toBeUndefined();
  });
});
