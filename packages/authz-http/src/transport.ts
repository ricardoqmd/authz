import {
  AuthorizationTransportError,
  type AuthorizationContext,
  type AuthorizationTransport,
  type DecisionRequest,
  type DecisionSet,
  type PermissionMenu,
  type TransportErrorKind,
} from "@ricardoqmd/authz-core";

/**
 * Everything this transport needs, and **all of it is configuration**.
 *
 * Nothing here is a constant in the package: not the base URL, not the header the authorization
 * context travels in, not how a token is obtained. A library that hardcoded any of them would be
 * asserting something about one deployment's backend, and this one is meant to work against any.
 */
export interface HttpTransportConfig {
  /** Where the three routes hang from. Joined with the paths below; a trailing slash is fine. */
  readonly baseUrl: string;
  /**
   * The request header the `contextId` travels in.
   *
   * **Configuration and never a constant.** This package must not know what any deployment calls
   * its authorization context, and a name baked in here would be exactly that knowledge.
   *
   * <p>Two preconditions on the `contextId` itself, because the symptom of breaking either is an
   * opaque failure rather than a message: it is sent **as a header value**, so it must be a valid
   * one; and **leading or trailing whitespace is not preserved** — the platform trims it on the
   * wire, silently, so a value that depends on it will not arrive as written.
   */
  readonly contextHeader: string;
  /**
   * The bearer token, or `null` when there is none.
   *
   * Returning `null` omits the `Authorization` header **entirely** — an empty one is a different
   * message to a backend than no header at all, and it is not the one we mean. **An empty string is
   * treated the same as `null`**, for the same reason: it is the absence of a token, not a token.
   */
  readonly getToken: () => Promise<string | null> | string | null;
  /**
   * The `fetch` to use. Defaults to the global.
   *
   * Injectable because it is what makes these tests real without a network, and what lets a
   * consumer wrap it — retries, tracing, a mock in its own tests — without this package growing
   * an opinion about any of that.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Classify a non-2xx response yourself. Returning `undefined` falls through to the default.
   *
   * It receives the parsed body **when the body parsed**, so a backend that distinguishes several
   * kinds of `403` can be understood by its own error code without this package knowing any of
   * them.
   */
  readonly classifyError?: (status: number, body: unknown) => TransportErrorKind | undefined;
}

/**
 * Build an {@link AuthorizationTransport} over `fetch`.
 *
 * <h2>Why this adapter is strict where the core is silent</h2>
 *
 * The core discards a response whose `app` or `contextId` does not match what it asked about —
 * silently and fail-closed, which is right, because an answer about another context is worse than
 * no answer. It has a documented trap: an adapter that casts a body without those fields produces a
 * **fully denied application with no error state anywhere**.
 *
 * This adapter closes the trap by failing loudly at the edge instead of quietly at the core. It
 * **reads `app` and `contextId` from the response body** and rejects when they are missing —
 * deliberately not filling them in from what it asked, which would make the core's guard
 * tautological and let a backend answering for the wrong context go unnoticed.
 *
 * At the edge the failure is a message a developer reads. Inside the core it would be a screen a
 * user cannot explain.
 */
export function createHttpTransport(config: HttpTransportConfig): AuthorizationTransport {
  const { baseUrl, contextHeader, getToken, classifyError } = config;
  const doFetch = config.fetch ?? globalThis.fetch;
  const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  async function headers(contextId?: string): Promise<Record<string, string>> {
    const out: Record<string, string> = { Accept: "application/json" };
    const token = await getToken();
    // Omitted ENTIRELY when there is no token. `Authorization: Bearer ` is a different statement
    // to a backend than sending nothing, and it is not the one we mean.
    //
    // Tested for TRUTHINESS and not merely against null/undefined: an empty string is the same
    // absence of a token, and letting it through sent exactly the header this comment says it
    // avoids.
    if (token) {
      out.Authorization = `Bearer ${token}`;
    }
    if (contextId !== undefined) {
      out[contextHeader] = contextId;
    }
    return out;
  }

  /**
   * One call, and the whole error taxonomy in one place.
   *
   * **No part of the response body ever reaches the thrown message.** The core removed its own
   * `reason` field precisely so that server text could not arrive one `render` away from a screen;
   * reintroducing it from below would undo that. The message is built from the route and the
   * status, and from nothing else — never the body, never the token, never the header value.
   */
  async function call(route: string, init: RequestInit, contextId?: string): Promise<unknown> {
    const url = `${root}${route}`;
    let response: Response;
    try {
      response = await doFetch(url, { ...init, headers: await headers(contextId) });
    } catch {
      throw new AuthorizationTransportError("UNAVAILABLE", `${route}: the request did not complete`);
    }

    // Parsed first, because `classifyError` is entitled to see the body when there is one — but a
    // body that does not parse is never an error in itself here, only a missing input to that hook.
    let body: unknown;
    let parsed = true;
    try {
      body = await response.json();
    } catch {
      parsed = false;
    }

    if (!response.ok) {
      // The hook is consumer code, so it is allowed to be wrong. If it throws we fall through to
      // the default — the same answer `undefined` already produces, and the one this package would
      // have given without a hook at all. Taking the application down because a classifier has a bug
      // would trade a handled error for an unhandled one and lose the 403 classification with it.
      //
      // Nothing from the thrown value is read, logged or re-thrown: it is consumer text, and it is
      // as untrusted here as a response body.
      let chosen: TransportErrorKind | undefined;
      try {
        chosen = classifyError?.(response.status, parsed ? body : undefined);
      } catch {
        chosen = undefined;
      }
      throw new AuthorizationTransportError(
        chosen ?? (response.status === 403 ? "NO_ACCESS_IN_APP" : "UNAVAILABLE"),
        `${route}: responded ${response.status}`,
      );
    }
    if (!parsed) {
      throw new AuthorizationTransportError("UNAVAILABLE", `${route}: the body is not JSON`);
    }
    return body;
  }

  return {
    async listContexts(app) {
      const route = `/me/apps/${segment(app)}/contracts`;
      // No context header here: this is the call that asks WHICH contexts exist.
      const body = await call(route, { method: "GET" });
      return contexts(body, route);
    },

    async fetchPermissions(app, contextId) {
      const route = `/me/apps/${segment(app)}/permissions`;
      const body = await call(route, { method: "GET" }, contextId);
      const record = object(body, route);
      return {
        app: required(record, "app", route),
        contextId: required(record, "contextId", route),
        permissions: array(record, "permissions", route) as PermissionMenu["permissions"],
      };
    },

    async fetchDecisions(app, contextId, request: DecisionRequest) {
      const route = `/me/apps/${segment(app)}/decisions`;
      const body = await call(
        route,
        { method: "POST", body: JSON.stringify(request) },
        contextId,
      );
      const record = object(body, route);
      return {
        app: required(record, "app", route),
        contextId: required(record, "contextId", route),
        decisions: array(record, "decisions", route) as DecisionSet["decisions"],
      };
    },
  };
}

/**
 * A path segment, percent-encoded.
 *
 * `encodeURIComponent` and not `encodeURI`: the latter leaves `/` and `?` alone, which is exactly
 * how an identifier escapes its segment and reaches a route nobody meant to call.
 */
function segment(value: string): string {
  return encodeURIComponent(value);
}

/** The package never guesses a shape: a body that is not an object is a broken adapter, loudly. */
function object(body: unknown, route: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AuthorizationTransportError("UNAVAILABLE", `${route}: the response is not an object`);
  }
  return body as Record<string, unknown>;
}

/**
 * A string field the answer must carry.
 *
 * This is the check the whole package exists for. The message names **the field and the route** so
 * that what a developer reads is "your backend did not echo `contextId` on this route", not an
 * application that denies everything and says nothing.
 */
function required(record: Record<string, unknown>, field: string, route: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new AuthorizationTransportError(
      "UNAVAILABLE",
      `${route}: the response is missing the "${field}" field, or it is not a string`,
    );
  }
  return value;
}

function array(record: Record<string, unknown>, field: string, route: string): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new AuthorizationTransportError(
      "UNAVAILABLE",
      `${route}: the response is missing the "${field}" array, or it is not an array`,
    );
  }
  return value;
}

/** The contexts call answers a top-level array, and every element must be a whole context. */
function contexts(body: unknown, route: string): readonly AuthorizationContext[] {
  if (!Array.isArray(body)) {
    throw new AuthorizationTransportError("UNAVAILABLE", `${route}: the response is not an array`);
  }
  return body.map((element, index) => {
    if (typeof element !== "object" || element === null) {
      throw new AuthorizationTransportError(
        "UNAVAILABLE",
        `${route}: context at index ${index} is not an object`,
      );
    }
    const record = element as Record<string, unknown>;
    if (
      typeof record.contextId !== "string" ||
      typeof record.label !== "string" ||
      typeof record.hasAccess !== "boolean"
    ) {
      throw new AuthorizationTransportError(
        "UNAVAILABLE",
        `${route}: context at index ${index} is missing "contextId", "label" or "hasAccess", ` +
          `or one of them has the wrong type`,
      );
    }
    return { contextId: record.contextId, label: record.label, hasAccess: record.hasAccess };
  });
}
