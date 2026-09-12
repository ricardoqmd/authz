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
  /*
   * `a/b` used to be the example here. It is REFUSED now — a separator in an application id survives
   * percent-encoding only until a proxy decodes it back — so the encoding property is shown with `?`,
   * which is a character the encoder handles and nothing downstream turns back into a separator.
   */
  it("an app id cannot escape its segment", async () => {
    const s = stub(() => json({ app: "a?b", permissions: [] }));
    await transport({ fetch: s.fetchDouble }).fetchPermissions("a?b");
    expect(s.calls[0]!.url).toBe(`${BASE}/me/apps/a%3Fb/permissions`);
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

/* 7 — the routes, which are configuration now ----------------------------- */

/*
 * The two paths used to be the only thing in this package that asserted something about one
 * deployment's backend. They are options now, with the old strings as their defaults, so the first
 * test here is the one that matters most: a caller who passes nothing must still produce the exact
 * URL it produced before. It asserts the URL the injected `fetch` received, not that the call
 * resolved — a wrong route that happens to be answered by the double would resolve just fine.
 */
describe("the routes are configuration, with today's values as defaults", () => {
  it("a caller that passes nothing gets the URLs it got before, character for character", async () => {
    const s = stub(byRoute());
    const t = transport({ fetch: s.fetchDouble });
    await t.fetchPermissions(APP);
    await t.fetchDecisions(APP, REQUEST);

    expect(s.calls.map((c) => c.url)).toEqual([
      "https://example.test/api/me/apps/app-a/permissions",
      "https://example.test/api/me/apps/app-a/decisions",
    ]);
  });

  it("a supplied path is used, and the other keeps its default", async () => {
    const s = stub(byRoute());
    const t = transport({
      fetch: s.fetchDouble,
      paths: { permissions: (encodedApp) => `/authz/${encodedApp}/menu` },
    });
    await t.fetchPermissions(APP);
    await t.fetchDecisions(APP, REQUEST);

    expect(s.calls.map((c) => c.url)).toEqual([
      "https://example.test/api/authz/app-a/menu",
      "https://example.test/api/me/apps/app-a/decisions",
    ]);
  });

  /*
   * BOTH SIDES ARE CALLED, and that is not decoration. Until this test called `fetchDecisions` too,
   * a configured `decisions` path could be ignored outright — the whole entry discarded in favour of
   * the default — and all 51 tests stayed green. The name promised two and the body exercised one,
   * which is how half a feature ships with no witness.
   *
   * ⚠️ The stub answers ONE body that satisfies both shapes — `app`, `permissions` AND `decisions` —
   * on purpose. Answering by route makes this test red for the wrong reason: the transport rejects
   * the body before the URLs are ever compared, and a witness that fails on a body shape is not a
   * witness for a route. With this body nothing can fail except the assertion that names the
   * behaviour.
   */
  it("both paths can be supplied, and BOTH are used", async () => {
    const s = stub(() => json({ app: APP, permissions: [], decisions: [] }));
    const t = transport({
      fetch: s.fetchDouble,
      paths: {
        permissions: (encodedApp) => `/v2/${encodedApp}/can`,
        decisions: (encodedApp) => `/v2/${encodedApp}/may`,
      },
    });
    await t.fetchPermissions(APP);
    await t.fetchDecisions(APP, REQUEST);

    expect(s.calls.map((c) => c.url)).toEqual([
      "https://example.test/api/v2/app-a/can",
      "https://example.test/api/v2/app-a/may",
    ]);
  });

  /*
   * THE GUARANTEE THAT DID NOT MOVE. The id is percent-encoded by this package BEFORE the configured
   * function sees it, so a consumer who interpolates it — which is all the doc asks — cannot let an
   * id escape its segment. Had the raw id been passed instead, this test would need the consumer to
   * remember `encodeURIComponent`, and the failure of forgetting is a route nobody meant to call.
   */
  it("the application id reaches a configured path ALREADY percent-encoded", async () => {
    const s = stub(() => json({ ...MENU, app: "a?b#c" }));
    const seen: string[] = [];
    await transport({
      fetch: s.fetchDouble,
      paths: {
        permissions: (encodedApp) => {
          seen.push(encodedApp);
          return `/authz/${encodedApp}/menu`;
        },
      },
    }).fetchPermissions("a?b#c");

    // Two entries, and the first is the construction probe: the function is called once with the
    // probe id before any request. A consumer whose path function has side effects needs to know
    // that, so this asserts the whole sequence instead of the last call.
    expect(seen).toEqual(["probe", "a%3Fb%23c"]);
    expect(s.calls[0]!.url).toBe("https://example.test/api/authz/a%3Fb%23c/menu");
    expect(s.calls[0]!.url).not.toContain("a?b#c");
  });

  it("the same id in the DEFAULT path is encoded too", async () => {
    const s = stub(() => json({ ...MENU, app: "a?b#c" }));
    await transport({ fetch: s.fetchDouble }).fetchPermissions("a?b#c");
    expect(s.calls[0]!.url).toBe("https://example.test/api/me/apps/a%3Fb%23c/permissions");
  });

  /*
   * A path without its leading slash builds a wrong URL, and silence is the one outcome this package
   * refuses. Both places it can be caught are asserted, and the second is the reason the first is
   * allowed to be timid.
   */
  it("a path missing its leading slash is rejected AT CONSTRUCTION, naming the option", () => {
    expect(() =>
      transport({ paths: { permissions: (encodedApp) => `me/apps/${encodedApp}/permissions` } }),
    ).toThrow(new RangeError('paths.permissions must return a path beginning with "/"'));
  });

  it("the decisions path is probed too, and names its own option", () => {
    expect(() =>
      transport({ paths: { decisions: (encodedApp) => `me/apps/${encodedApp}/decisions` } }),
    ).toThrow(new RangeError('paths.decisions must return a path beginning with "/"'));
  });

  it("a path that goes bad only for a real id is rejected AT CALL TIME, not silently", async () => {
    const s = stub(byRoute());
    // The probe id passes; the real one does not. No construction check can see this, which is why
    // the call-time check exists and why the probe is not the whole guard.
    const t = transport({
      fetch: s.fetchDouble,
      paths: { permissions: (encodedApp) => (encodedApp === "app-a" ? "no-slash" : "/probe/ok") },
    });

    await expect(t.fetchPermissions(APP)).rejects.toThrow(
      new RangeError('paths.permissions must return a path beginning with "/"'),
    );
    expect(s.calls).toEqual([]);
  });

  it("an empty path is rejected as well: it would silently call the base URL itself", () => {
    expect(() => transport({ paths: { permissions: () => "" } })).toThrow(RangeError);
  });

  /*
   * THE PROBE IS DELIBERATELY TIMID, and this is the test that keeps it that way. A path looked up
   * by application id is entitled not to know an id it has never been given; rejecting that would
   * turn a working configuration into a construction error.
   */
  it("a path function that throws for the probe id is NOT rejected at construction", async () => {
    const s = stub(byRoute());
    const known: Record<string, string> = { "app-a": "/authz/app-a/menu" };
    const t = transport({
      fetch: s.fetchDouble,
      paths: {
        permissions: (encodedApp) => {
          const found = known[encodedApp];
          if (found === undefined) throw new Error("unknown application");
          return found;
        },
      },
    });

    await t.fetchPermissions(APP);
    expect(s.calls[0]!.url).toBe("https://example.test/api/authz/app-a/menu");
  });

  it("a path function that returns a non-string for the probe id is not rejected either", async () => {
    const s = stub(byRoute());
    const t = transport({
      fetch: s.fetchDouble,
      paths: {
        permissions: (encodedApp) =>
          (({ "app-a": "/authz/app-a/menu" }) as Record<string, string>)[encodedApp] as string,
      },
    });

    await t.fetchPermissions(APP);
    expect(s.calls[0]!.url).toBe("https://example.test/api/authz/app-a/menu");
  });
});

/* 8 — the ids that cannot be a path segment ------------------------------- */

/*
 * `encodeURIComponent` leaves a dot alone, and the URL parser resolves dot segments before the
 * request goes out — so `..` used to leave for one route up, WITH the Authorization header, and `.`
 * used to collapse its own segment. Encoding them does not help: the parser decodes first. The only
 * faithful answer is to refuse them, and the empty string with them, since it occupies no segment at
 * all.
 */
describe("an application id that cannot be a path segment is refused", () => {
  /*
   * EVERY REFUSED VALUE, THROUGH EVERY DOOR. Four values x two calls x three route shapes (default,
   * a configured permissions path, a configured decisions path). Anything less left real bypasses
   * green: a refusal that covered only ".." on the default path passed the whole suite, and so did a
   * configured decisions path that encoded the id itself instead of going through `segment`.
   *
   * `s.calls` empty is the assertion that names the harm — the old behaviour was a request that LEFT,
   * with the Authorization header on it.
   */
  const REFUSED = ["..", ".", "", "/"] as const;
  const DOORS = [
    ["default path", {}],
    ["configured permissions path", { paths: { permissions: (a: string) => `/authz/${a}/menu` } }],
    ["configured decisions path", { paths: { decisions: (a: string) => `/authz/${a}/may` } }],
  ] as const;

  for (const [door, over] of DOORS) {
    for (const id of REFUSED) {
      it(`${JSON.stringify(id)} is refused on fetchPermissions via the ${door}, and NOTHING is sent`, async () => {
        const s = stub(byRoute());
        const outcome = await transport({ fetch: s.fetchDouble, ...over })
          .fetchPermissions(id)
          .then(() => "sent", (e: unknown) => (e as Error).name);

        expect([id, outcome]).toEqual([id, "RangeError"]);
        expect(s.calls).toEqual([]);
      });

      it(`${JSON.stringify(id)} is refused on fetchDecisions via the ${door}, and NOTHING is sent`, async () => {
        const s = stub(byRoute());
        const outcome = await transport({ fetch: s.fetchDouble, ...over })
          .fetchDecisions(id, REQUEST)
          .then(() => "sent", (e: unknown) => (e as Error).name);

        expect([id, outcome]).toEqual([id, "RangeError"]);
        expect(s.calls).toEqual([]);
      });
    }
  }

  /*
   * THE OTHER HALF, and it is the one that keeps the refusal honest: only three values are refused.
   * An id that merely LOOKS dangerous is encoded and sent, because it does not escape — measured
   * against a real server for every one of these.
   */
  it("ids that look dangerous but stay in their segment are still sent, encoded", async () => {
    for (const [id, encoded] of [
      ["...", "..."],
      ["a..b", "a..b"],
      ["%2e%2e", "%252e%252e"],
      ["a?b", "a%3Fb"],
      ["a b", "a%20b"],
    ] as const) {
      const s = stub(() => json({ ...MENU, app: id }));
      // The outcome is READ and not awaited bare: a refusal must fail the assertion that names the
      // behaviour, not prevent it from running. An over-broad refusal used to reject here and the
      // URL was never compared at all.
      const outcome = await transport({ fetch: s.fetchDouble })
        .fetchPermissions(id)
        .then(() => "sent", (e: unknown) => `${(e as Error).name}: ${(e as Error).message}`);

      expect([id, outcome]).toEqual([id, "sent"]);
      expect(s.calls[0]?.url).toBe(`https://example.test/api/me/apps/${encoded}/permissions`);
    }
  });
});

/* 9 — the request that has a body says what the body is ------------------- */

describe("the decisions request declares its content type", () => {
  /*
   * THE COMPLETE SET, with strict equality, on BOTH calls. `toBeUndefined` on one key was not enough:
   * a lower-case `content-type` on the GET, or the key present with the value `undefined`, both
   * passed the whole suite — and on the wire the GET carried a content type in each case. What the
   * request actually sends is the whole record, so the whole record is what is asserted.
   */
  it("the POST sends exactly these headers", async () => {
    const s = stub(() => json(SET));
    await transport({ fetch: s.fetchDouble }).fetchDecisions(APP, REQUEST);

    expect(headersOf(s.calls[0]!.init)).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer tok-123",
    });
  });

  it("the GET, which has no body, sends exactly these — and no content type under any spelling", async () => {
    const s = stub(() => json(MENU));
    await transport({ fetch: s.fetchDouble }).fetchPermissions(APP);

    const sent = headersOf(s.calls[0]!.init);
    expect(sent).toEqual({ Accept: "application/json", Authorization: "Bearer tok-123" });
    // Strict equality already forbids it; this says the reason out loud, because the two mutations
    // that slipped through were a lower-case key and a key whose value was `undefined`.
    expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain("content-type");
  });

  it("the other headers are unchanged by it", async () => {
    const s = stub(byRoute({ contextId: CTX }));
    await withContext({ fetch: s.fetchDouble }).fetchDecisions(APP, REQUEST);

    expect(headersOf(s.calls[0]!.init)).toEqual({
      Accept: "application/json",
      Authorization: "Bearer tok-123",
      "X-Context-Id": CTX,
      "Content-Type": "application/json",
    });
  });
});
