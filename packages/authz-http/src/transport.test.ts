import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationTransportError,
  type AuthorizationTransport,
  type TransportErrorKind,
} from "@ricardoqmd/authz-core";

import { createHttpTransport, type HttpTransportConfig } from "./index.js";

const BASE = "https://example.test/api";
const APP = "app-a";
const CTX = "c-1";
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

function transport(over: Partial<HttpTransportConfig> = {}): AuthorizationTransport {
  return createHttpTransport({
    baseUrl: BASE,
    contextHeader: HEADER,
    getToken: () => "tok-123",
    ...over,
  });
}

/** The headers of the nth recorded call, as a plain record. */
function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

const MENU = { app: APP, contextId: CTX, permissions: [{ action: "read", effect: "PERMIT" }] };
const SET = { app: APP, contextId: CTX, decisions: [] };
const CONTEXTS = [{ contextId: CTX, label: "One", hasAccess: true }];
const REQUEST = { resourceType: "orders", actions: ["read"], resourceIds: ["r-1"] };

/* 1 & 2 — the context header --------------------------------------------- */

describe("the context header", () => {
  it("carries the context id on the two calls that take one", async () => {
    const s = stub(() => json(MENU));
    const t = transport({ fetch: s.fetchDouble });

    await t.fetchPermissions(APP, CTX);
    expect(headersOf(s.calls[0]!.init)[HEADER]).toBe(CTX);

    const s2 = stub(() => json(SET));
    await transport({ fetch: s2.fetchDouble }).fetchDecisions(APP, CTX, REQUEST);
    expect(headersOf(s2.calls[0]!.init)[HEADER]).toBe(CTX);
  });

  /** The contexts call is the one that asks WHICH contexts exist; it cannot carry one. */
  it("is absent on the contexts call", async () => {
    const s = stub(() => json(CONTEXTS));

    await transport({ fetch: s.fetchDouble }).listContexts(APP);

    expect(headersOf(s.calls[0]!.init)).not.toHaveProperty(HEADER);
  });

  /** Catches a header name hidden as a constant in the code. */
  it("takes its NAME from configuration, not from this package", async () => {
    const a = stub(() => json(MENU));
    const b = stub(() => json(MENU));

    await transport({ fetch: a.fetchDouble, contextHeader: "X-One" }).fetchPermissions(APP, CTX);
    await transport({ fetch: b.fetchDouble, contextHeader: "X-Two" }).fetchPermissions(APP, CTX);

    expect(headersOf(a.calls[0]!.init)).toHaveProperty("X-One", CTX);
    expect(headersOf(a.calls[0]!.init)).not.toHaveProperty("X-Two");
    expect(headersOf(b.calls[0]!.init)).toHaveProperty("X-Two", CTX);
  });
});

/* 3 — the token ----------------------------------------------------------- */

describe("the Authorization header", () => {
  it("is present when getToken yields a token", async () => {
    const s = stub(() => json(CONTEXTS));

    await transport({ fetch: s.fetchDouble, getToken: () => "abc" }).listContexts(APP);

    expect(headersOf(s.calls[0]!.init).Authorization).toBe("Bearer abc");
  });

  /**
   * ABSENT, not empty. `Authorization: Bearer ` is a different statement to a backend than sending
   * nothing at all, and it is not the one we mean — so the assertion is on absence.
   */
  it("is absent ENTIRELY when getToken yields null", async () => {
    const s = stub(() => json(CONTEXTS));

    await transport({ fetch: s.fetchDouble, getToken: () => null }).listContexts(APP);

    expect(headersOf(s.calls[0]!.init)).not.toHaveProperty("Authorization");
  });

  it("is absent when getToken yields an EMPTY STRING, not just null", async () => {
    // `Authorization: Bearer ` is a different statement to a backend than sending nothing. The
    // guard tested null and undefined, so an empty token sent exactly the header the code's own
    // comment says it avoids.
    const s = stub(() => json(CONTEXTS));

    await transport({ fetch: s.fetchDouble, getToken: () => "" }).listContexts(APP);

    expect(headersOf(s.calls[0]!.init)).not.toHaveProperty("Authorization");
  });

  it("awaits an async getToken", async () => {
    const s = stub(() => json(CONTEXTS));

    await transport({
      fetch: s.fetchDouble,
      getToken: async () => "later",
    }).listContexts(APP);

    expect(headersOf(s.calls[0]!.init).Authorization).toBe("Bearer later");
  });
});

/* 4 — encoding ------------------------------------------------------------ */

describe("the Accept header", () => {
  it("asks for JSON on every call", async () => {
    const s = stub((url) => json(url.endsWith("/permissions") ? MENU : CONTEXTS));
    const t = transport({ fetch: s.fetchDouble });

    await t.listContexts(APP);
    await t.fetchPermissions(APP, CTX);

    for (const call of s.calls) {
      expect(headersOf(call.init).Accept).toBe("application/json");
    }
  });
});

describe("path segments are encoded", () => {
  it.each([
    ["a slash", "a/b", "a%2Fb"],
    ["a query mark", "a?b", "a%3Fb"],
    ["a fragment and a space", "a #b", "a%20%23b"],
  ])("%s in the app cannot escape its segment", async (_name, app, encoded) => {
    const s = stub(() => json(CONTEXTS));

    await transport({ fetch: s.fetchDouble }).listContexts(app);

    expect(s.calls[0]!.url).toBe(`${BASE}/me/apps/${encoded}/contracts`);
  });
});

/* 5 — THE TRAP THIS ROUND EXISTS TO CLOSE --------------------------------- */

describe("a response that does not echo what it was asked about is rejected LOUDLY", () => {
  /**
   * The core discards such an answer silently and fail-closed — correctly, but the consequence of
   * an adapter that never populates these fields is a fully denied application with no error state
   * anywhere. Here it is a message a developer reads instead.
   */
  it.each([
    ["a menu missing app", { contextId: CTX, permissions: [] }, "app", "/permissions"],
    ["a menu missing contextId", { app: APP, permissions: [] }, "contextId", "/permissions"],
  ])("%s rejects, naming the field and the route", async (_n, body, field, route) => {
    const s = stub(() => json(body));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchPermissions(APP, CTX)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AuthorizationTransportError);
      expect((error as AuthorizationTransportError).kind).toBe("UNAVAILABLE");
      expect((error as Error).message).toContain(field);
      expect((error as Error).message).toContain(route);
      return true;
    });
  });

  it.each([
    ["a decision set missing app", { contextId: CTX, decisions: [] }, "app"],
    ["a decision set missing contextId", { app: APP, decisions: [] }, "contextId"],
  ])("%s rejects, naming the field and the route", async (_n, body, field) => {
    const s = stub(() => json(body));
    const t = transport({ fetch: s.fetchDouble });

    await expect(t.fetchDecisions(APP, CTX, REQUEST)).rejects.toSatisfy((error: unknown) => {
      expect((error as Error).message).toContain(field);
      expect((error as Error).message).toContain("/decisions");
      return true;
    });
  });

  /**
   * The fields are read from the BODY, never filled in from what was asked. Copying the request's
   * own values would make the core's guard tautological, and a backend answering for the wrong
   * context would go unnoticed — which is the whole failure this package is here to make visible.
   */
  it("passes hasAccess THROUGH, including false", async () => {
    // The one field the core branches on to deny WITHOUT consulting the backend. A transport that
    // always answered true would delete that branch from the system and nothing would notice —
    // which is why no fixture carrying `false` meant the pass-through was undefended.
    const s = stub(() =>
      json([
        { contextId: "c-1", label: "One", hasAccess: true },
        { contextId: "c-2", label: "Two", hasAccess: false },
      ]),
    );

    const out = await transport({ fetch: s.fetchDouble }).listContexts(APP);

    expect(out.map((c) => c.hasAccess)).toEqual([true, false]);
  });

  it("passes through what the BODY says, not what was asked", async () => {
    const s = stub(() => json({ app: "another-app", contextId: "another-ctx", permissions: [] }));

    const menu = await transport({ fetch: s.fetchDouble }).fetchPermissions(APP, CTX);

    expect(menu.app).toBe("another-app");
    expect(menu.contextId).toBe("another-ctx");
  });

  it.each([
    ["permissions", { app: APP, contextId: CTX }],
    ["a permissions array", { app: APP, contextId: CTX, permissions: "nope" }],
  ])("a menu missing %s rejects", async (_n, body) => {
    const s = stub(() => json(body));
    await expect(transport({ fetch: s.fetchDouble }).fetchPermissions(APP, CTX)).rejects.toThrow(
      AuthorizationTransportError,
    );
  });

  it.each([
    ["not an array", { contexts: [] }],
    ["an element that is not an object", ["nope"]],
    ["an element missing contextId", [{ label: "One", hasAccess: true }]],
    ["an element whose hasAccess is not a boolean", [{ contextId: CTX, label: "One", hasAccess: "yes" }]],
  ])("a contexts response that is %s rejects", async (_n, body) => {
    const s = stub(() => json(body));
    await expect(transport({ fetch: s.fetchDouble }).listContexts(APP)).rejects.toThrow(
      AuthorizationTransportError,
    );
  });
});

/* 6 & 7 — error classification -------------------------------------------- */

describe("error classification", () => {
  it("maps 403 to NO_ACCESS_IN_APP and everything else to UNAVAILABLE", async () => {
    for (const [status, kind] of [
      [403, "NO_ACCESS_IN_APP"],
      [401, "UNAVAILABLE"],
      [404, "UNAVAILABLE"],
      [500, "UNAVAILABLE"],
    ] as const) {
      const s = stub(() => json({ error: "x" }, status));
      await expect(transport({ fetch: s.fetchDouble }).listContexts(APP)).rejects.toSatisfy(
        (error: unknown) => {
          expect((error as AuthorizationTransportError).kind).toBe(kind);
          return true;
        },
      );
    }
  });

  it("maps a network rejection to UNAVAILABLE", async () => {
    const fetchDouble = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof globalThis.fetch;

    await expect(transport({ fetch: fetchDouble }).listContexts(APP)).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as AuthorizationTransportError).kind).toBe("UNAVAILABLE");
        return true;
      },
    );
  });

  it.each([
    ["a null body where an object is expected", () => json(null), "fetchPermissions"],
    ["a [null] element where a context is expected", () => json([null]), "listContexts"],
  ])("maps %s to UNAVAILABLE, not a raw TypeError", async (_n, answer, method) => {
    // Without the shape guards these reached property access on null and surfaced a TypeError,
    // which is neither an outcome of the taxonomy nor something a consumer can branch on.
    const s = stub(answer);
    const t = transport({ fetch: s.fetchDouble });
    const call =
      method === "listContexts" ? t.listContexts(APP) : t.fetchPermissions(APP, CTX);

    await expect(call).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AuthorizationTransportError);
      expect((error as AuthorizationTransportError).kind).toBe("UNAVAILABLE");
      return true;
    });
  });

  it("maps a 2xx body that is not JSON to UNAVAILABLE", async () => {
    const s = stub(() => new Response("<html>not json</html>", { status: 200 }));

    await expect(transport({ fetch: s.fetchDouble }).listContexts(APP)).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as AuthorizationTransportError).kind).toBe("UNAVAILABLE");
        return true;
      },
    );
  });

  it("lets classifyError override, and sees the parsed body", async () => {
    const seen: { status: number; body: unknown }[] = [];
    const classifyError = (status: number, body: unknown): TransportErrorKind | undefined => {
      seen.push({ status, body });
      return "NO_ACCESS_IN_APP";
    };
    const s = stub(() => json({ code: "SEAT_EXPIRED" }, 500));

    await expect(
      transport({ fetch: s.fetchDouble, classifyError }).listContexts(APP),
    ).rejects.toSatisfy((error: unknown) => {
      // 500 would default to UNAVAILABLE; the hook wins.
      expect((error as AuthorizationTransportError).kind).toBe("NO_ACCESS_IN_APP");
      return true;
    });
    expect(seen[0]).toEqual({ status: 500, body: { code: "SEAT_EXPIRED" } });
  });

  it("falls through to the default when classifyError returns undefined", async () => {
    const s = stub(() => json({}, 403));

    await expect(
      transport({ fetch: s.fetchDouble, classifyError: () => undefined }).listContexts(APP),
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as AuthorizationTransportError).kind).toBe("NO_ACCESS_IN_APP");
      return true;
    });
  });

  /**
   * A hook that throws is a bug in CONSUMER code. Unguarded, it turned a handled error into an
   * unhandled one and took the 403 classification down with it. The answer is to behave as if the
   * hook were not there — the same default `undefined` already produces.
   */
  describe("a classifyError that THROWS does not escape", () => {
    const HOOK_SECRET = "classifier blew up with token tok-SECRET";
    const throws = (): never => {
      throw new Error(HOOK_SECRET);
    };

    it.each([
      [403, "NO_ACCESS_IN_APP" as TransportErrorKind],
      [500, "UNAVAILABLE" as TransportErrorKind],
    ])("still classifies a %i as %s", async (status, kind) => {
      const s = stub(() => json({}, status));

      await expect(
        transport({ fetch: s.fetchDouble, classifyError: throws }).listContexts(APP),
      ).rejects.toSatisfy((error: unknown) => {
        expect((error as AuthorizationTransportError).kind).toBe(kind);
        return true;
      });
    });

    it("carries nothing the hook threw into the message", async () => {
      const s = stub(() => json({}, 403));

      await expect(
        transport({ fetch: s.fetchDouble, classifyError: throws }).listContexts(APP),
      ).rejects.toSatisfy((error: unknown) => {
        expect((error as Error).message).not.toContain(HOOK_SECRET);
        expect((error as Error).message).not.toContain("tok-SECRET");
        return true;
      });
    });
  });
});

/* 8 — no body text escapes ------------------------------------------------ */

describe("nothing from a response body reaches a thrown message", () => {
  /**
   * The core deleted its own `reason` field so that server text could not arrive one `render` away
   * from a screen. Reintroducing the leak from below would undo that, so the message is built from
   * the route and the status and from nothing else.
   */
  const SECRET = "connection to db://internal rejected for user root";

  it.each([
    ["an error body", () => json({ message: SECRET, detail: SECRET }, 500)],
    ["a non-JSON body", () => new Response(SECRET, { status: 200 })],
    ["a 2xx body missing its fields", () => json({ note: SECRET })],
  ])("%s does not appear in the error", async (_n, answer) => {
    const s = stub(answer);

    await expect(transport({ fetch: s.fetchDouble }).fetchPermissions(APP, CTX)).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as Error).message).not.toContain(SECRET);
        expect((error as Error).message).not.toContain("db://internal");
        return true;
      },
    );
  });

  it("does not leak what a REJECTED getToken threw", async () => {
    // This path carries getToken failures, so the leak surface is token-provider error text
    // reaching a message the core could surface — exactly what the core deleted `reason` to stop.
    const s = stub(() => json(CONTEXTS));

    await expect(
      transport({
        fetch: s.fetchDouble,
        getToken: () => Promise.reject(new Error(SECRET)),
      }).fetchPermissions(APP, CTX),
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).not.toContain("db://internal");
      return true;
    });
  });

  it("does not leak the token or the header value either", async () => {
    const s = stub(() => json({}, 500));

    await expect(
      transport({ fetch: s.fetchDouble, getToken: () => "tok-SECRET" }).fetchPermissions(
        APP,
        "ctx-SECRET",
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as Error).message).not.toContain("tok-SECRET");
      expect((error as Error).message).not.toContain("ctx-SECRET");
      return true;
    });
  });
});

/* 9 — the port ------------------------------------------------------------ */

describe("the port", () => {
  /**
   * A type-level assertion: `transport()` is declared as `AuthorizationTransport`, so a change in
   * the core's port breaks THIS package's build rather than a consumer's runtime. The runtime part
   * only checks the three methods are there.
   */
  it("satisfies AuthorizationTransport", () => {
    const t: AuthorizationTransport = createHttpTransport({
      baseUrl: BASE,
      contextHeader: HEADER,
      getToken: () => null,
    });

    expect(typeof t.listContexts).toBe("function");
    expect(typeof t.fetchPermissions).toBe("function");
    expect(typeof t.fetchDecisions).toBe("function");
  });

  it("defaults fetch to the global when none is injected", async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => json(CONTEXTS));
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    try {
      await createHttpTransport({
        baseUrl: BASE,
        contextHeader: HEADER,
        getToken: () => null,
      }).listContexts(APP);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends the request as the POST body on the decisions call", async () => {
    const s = stub(() => json(SET));

    await transport({ fetch: s.fetchDouble }).fetchDecisions(APP, CTX, REQUEST);

    expect(s.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(s.calls[0]!.init.body))).toEqual(REQUEST);
  });
});
