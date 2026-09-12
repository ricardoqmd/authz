import {
  AuthorizationTransportError,
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
   * The authorization context to send, **optional**.
   *
   * **Omit it and this package has no context concept at all**: no header is sent and no echo is
   * required, which is the mode a consumer whose backend has never heard of contexts uses.
   *
   * When it IS supplied, {@link contextHeader} must be too, and the response body is required to
   * echo it back — see the constructor's rejection rules.
   *
   * <p>Two preconditions on the value, because the symptom of breaking either is an opaque failure
   * rather than a message: it is sent **as a header value**, so it must be a valid one; and
   * **leading or trailing whitespace is not preserved** — the platform trims it on the wire,
   * silently, so a value that depends on it will not arrive as written.
   */
  readonly contextId?: string;
  /**
   * The request header {@link contextId} travels in. **Required only when `contextId` is given.**
   *
   * **Configuration and never a constant.** This package must not know what any deployment calls
   * its authorization context, and a name baked in here would be exactly that knowledge.
   */
  readonly contextHeader?: string;
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
  /**
   * Where the two routes live, **optional**. Omit it and you get the defaults, which are the only
   * paths this package used to know:
   *
   * ```
   * permissions  (encodedApp) => `/me/apps/${encodedApp}/permissions`
   * decisions    (encodedApp) => `/me/apps/${encodedApp}/decisions`
   * ```
   *
   * Either entry may be given on its own; the other keeps its default.
   *
   * <h3>`encodedApp` arrives PERCENT-ENCODED, and that is the whole point of the parameter's name</h3>
   *
   * **Interpolate it and nothing else.** The package encodes the application id with
   * `encodeURIComponent` before your function sees it, and **four ids that encoding cannot make safe
   * are REFUSED outright**, with a `RangeError` and no request sent: `".."`, `"."`, `""` and any id
   * containing `/`. The refusal runs before your function is called, so a configured path cannot walk
   * around it. Had the raw id been passed instead, that guarantee would have moved to you silently,
   * and forgetting to encode is the ordinary mistake.
   *
   * ⚠️ **What is guaranteed, and where it stops: the segment in the URL THIS PACKAGE CONSTRUCTS.**
   * An id occupies exactly one segment of that URL. What a reverse proxy does with it afterwards is
   * outside this package's reach: 📐 measured against `nginx 1.29.3` with
   * `proxy_pass http://upstream/api/;`, `%2F` is decoded and the dot segments re-resolved, so before
   * the `/` refusal existed `"../secret"` left here as `/api/me/apps/..%2Fsecret/permissions` and the
   * upstream received `/api/me/secret/permissions`, with the `Authorization` header. `%5C` was NOT
   * decoded by that proxy, which is why `\` is not refused and `/` is.
   *
   * **Do not encode it again.** ⚠️ **For an ordinary id it changes nothing**:
   * `encodeURIComponent("app-a")` is `"app-a"` and encoding it twice is still `"app-a"`, so a
   * suite whose ids are all ordinary never sees the mistake. For an id with a `/`, a space or an
   * accent it produces `%252F`, `%2520` or `%25C3%25B1` and a route your backend does not
   * recognise — **and nothing announces that either.** Through a session a double-encoded
   * `permissions` path shows `UNAVAILABLE`, or `NO_ACCESS_IN_APP` from a backend that answers `403`
   * for an application it does not know; a double-encoded `decisions` path shows `READY` with every
   * decision denied. Nothing is printed in any of those cases.
   *
   * <h3>What is rejected, and when</h3>
   *
   * The returned path must be a non-empty string beginning with `/`; it is joined to
   * {@link baseUrl} verbatim. A path without the leading slash produces a wrong URL, and this package
   * will not build one silently:
   *
   * - **At construction**, each function given is called ONCE with the probe id `"probe"`, before any
   *   request is made — so a path function with side effects will see that call. If it returns a string
   *   that does not begin with `/`, the constructor throws a `RangeError` — the same place and the
   *   same class as the other configuration mistakes here. If it throws, or returns something that is
   *   not a string, the probe concludes nothing: a function that looks its path up by id is entitled
   *   not to know a value it has never been given.
   * - **At call time**, every path is checked before it is used, and a bad one is a `RangeError`
   *   naming which option produced it — **for whoever called this transport**. ⚠️ Read the next
   *   paragraph before relying on that: through the core, nobody is told anything, and the two paths
   *   fail differently.
   *
   * <h3>⚠️ What a call-time path error looks like from ABOVE</h3>
   *
   * **Nothing names it.** Neither this package nor the core has a diagnostic channel — the core says
   * so about itself, and no published code of any of the three packages calls `console`. The
   * `RangeError` reaches whoever called `fetchPermissions` or `fetchDecisions`
   * directly; through `createAuthorizationSession` it is caught and turned into state, and nothing is
   * printed anywhere.
   *
   * 📐 And the two options do not fail alike. Measured through a real core session, with a path that
   * passes the construction probe and fails for the real id, against a backend that permits `read`
   * on `r-1`:
   *
   *     wrong option       session state   decisionFor(read, r-1)   console calls
   *     -----------------  --------------  -----------------------  -------------
   *     paths.permissions  UNAVAILABLE     PERMIT                   0
   *     paths.decisions    READY           DENY                     0
   *
   * 🔴 **A wrong `paths.decisions` is the dangerous one.** The menu loads, so the screen is `READY`
   * and complete; the decision call's chunk rejects, a rejected chunk contributes nothing by the
   * core's own fail-closed contract, and what is absent reads as a denial. **The result is a working
   * screen where everything is denied, indistinguishable from a real denial.** A wrong
   * `paths.permissions` is the milder one: the screen says unavailable, while `decide()` — whose path
   * is fine — keeps answering what the backend says.
   *
   * That per-chunk behaviour is the core's contract for ANY decision failure and is not new here.
   * What is new is a configuration option that can cause it. **No state will tell you the
   * decisions path is wrong, so check it in a way that can fail**: call `fetchPermissions` and
   * `fetchDecisions` on the transport directly, or assert through a session a `PERMIT` you know the
   * subject has — a session shows a wrong decisions path as a denial — and do it **for every
   * application id you will use**, not one. A lookup that knows `app-a` and forgot `app-b` passes
   * construction, answers `app-a` correctly and fails for `app-b` alone.
   *
   * <h3>⚠️ A path is not a place to put a secret</h3>
   *
   * The route travels into every message this transport throws — `` `${route}: responded 403` `` and
   * the rest. That is deliberate and documented: the message is built from the route and the status
   * and from nothing else. Whatever you put in the path is part of the route, so **a token, a key or
   * anything else you would not want in a log or an error report does not belong there.** This
   * package cannot prevent it and does not try.
   */
  readonly paths?: {
    readonly permissions?: (encodedApp: string) => string;
    readonly decisions?: (encodedApp: string) => string;
  };
}

/**
 * Build an {@link AuthorizationTransport} over `fetch`.
 *
 * <h2>Why this adapter is strict where the core is silent</h2>
 *
 * The core discards a response whose `app` does not match what it asked about — silently and
 * fail-closed, which is right, because an answer about another application is worse than no
 * answer. It has a documented trap: an adapter that casts a body without that field produces a
 * **fully denied application with no error state anywhere**.
 *
 * This adapter closes the trap by failing loudly at the edge instead of quietly at the core. It
 * **reads `app` from the response body** and rejects when it is missing — deliberately not filling
 * it in from what it asked, which would make the core's guard tautological.
 *
 * At the edge the failure is a message a developer reads. Inside the core it would be a screen a
 * user cannot explain.
 *
 * <h2>The context pair, and why the echo check lives here now</h2>
 *
 * The core no longer knows what a context is, so the check that a response is about the context we
 * asked about moved to where the knowledge is. Three modes, and the third is a construction error
 * on purpose:
 *
 * - **Neither `contextId` nor `contextHeader`:** no header is sent, no echo is required. A backend
 *   that has never heard of contexts works unchanged.
 * - **Both:** the header carries the id, and a response body whose `contextId` does not echo it is
 *   **rejected loudly**, with the same message discipline as every other rejection here — the route
 *   and the field, never the body, never the token, never the header value.
 * - **One without the other:** rejected at construction with a `RangeError` naming which is
 *   missing. A header name with nothing to put in it, or an id with nowhere to send it, is a
 *   configuration mistake, and discovering it as a `401` costs far more than discovering it here.
 */
export function createHttpTransport(config: HttpTransportConfig): AuthorizationTransport {
  const { baseUrl, contextId, contextHeader, getToken, classifyError } = config;
  const doFetch = config.fetch ?? globalThis.fetch;
  const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  const permissionsPath = config.paths?.permissions ?? defaultPermissionsPath;
  const decisionsPath = config.paths?.decisions ?? defaultDecisionsPath;

  // Rejected HERE and not at the first call: a misconfiguration that only surfaces once a route is
  // exercised is one a consumer meets in an environment, not in a test.
  if (contextId !== undefined && contextHeader === undefined) {
    throw new RangeError("contextHeader is required when contextId is supplied");
  }
  if (contextHeader !== undefined && contextId === undefined) {
    throw new RangeError("contextId is required when contextHeader is supplied");
  }
  probePath(config.paths?.permissions, "paths.permissions");
  probePath(config.paths?.decisions, "paths.decisions");

  /**
   * The path for one call, encoded and checked.
   *
   * The encoding happens HERE, not in the consumer's function, so the guarantee below `segment`
   * describes cannot be handed away by a configuration option.
   */
  function routeFor(path: (encodedApp: string) => string, app: string, option: string): string {
    return requirePath(path(segment(app)), option);
  }

  async function headers(hasBody: boolean): Promise<Record<string, string>> {
    const out: Record<string, string> = { Accept: "application/json" };
    // THE REQUEST THAT HAS A BODY SAYS WHAT THE BODY IS, and only that one. `body` is a string, so
    // without this the platform labels it `text/plain;charset=UTF-8`.
    //
    // 📐 Measured against a real server before this line existed: the POST arrived as
    // `content-type: text/plain;charset=UTF-8`, a backend that requires JSON answered `415`, the
    // chunk was dropped, and the session sat at `READY` with zero decisions and `DENY` for a pair
    // the backend would have permitted — the working screen with everything denied that this file
    // warns about elsewhere.
    //
    // Keyed on the body and not on the method so that a future route with a body cannot forget it.
    //
    // 🔴 IN A BROWSER, ACROSS ORIGINS, THIS AFFECTS ALL FOUR CONFIGURATIONS. 📐 Measured in Chrome
    // 152 and Firefox 151, page and backend on different origins, through a session: in the first
    // three the preflight now asks for `content-type` beside `Authorization` or the context header,
    // and a backend whose `Access-Control-Allow-Headers` names only those two fails it; in the
    // fourth — no token and no context pair — the content type is the only reason the decisions
    // request is preflighted at all, and a backend that does not answer `OPTIONS` fails it.
    //
    // Either way the browser never sends the POST and nothing says so: the menu request carries no
    // content type and still loads, so the screen is `READY` and every decision reads `DENY`, for
    // pairs the backend permits too. With `Content-Type` among the allowed headers all four answered
    // what the backend said; same-origin, neither browser sent an `OPTIONS` in any configuration.
    // The README says it where a consumer will look for it.
    if (hasBody) {
      out["Content-Type"] = "application/json";
    }
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
    if (contextId !== undefined && contextHeader !== undefined) {
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
  async function call(route: string, init: RequestInit): Promise<unknown> {
    const url = `${root}${route}`;
    let response: Response;
    try {
      response = await doFetch(url, { ...init, headers: await headers(init.body !== undefined) });
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

  /**
   * The echo check, in the one place that still knows what was asked.
   *
   * Only runs when a `contextId` was configured. It reads the field from the body and compares —
   * it does not fill it in from what it sent, which would make the check tautological and let a
   * backend answering for the wrong context go unnoticed.
   */
  function requireContextEcho(record: Record<string, unknown>, route: string): void {
    if (contextId === undefined) {
      return;
    }
    const echoed = required(record, "contextId", route);
    if (echoed !== contextId) {
      throw new AuthorizationTransportError(
        "UNAVAILABLE",
        `${route}: the response "contextId" does not echo the one that was sent`,
      );
    }
  }

  return {
    async fetchPermissions(app) {
      const route = routeFor(permissionsPath, app, "paths.permissions");
      const body = await call(route, { method: "GET" });
      const record = object(body, route);
      requireContextEcho(record, route);
      return {
        app: required(record, "app", route),
        permissions: array(record, "permissions", route) as PermissionMenu["permissions"],
      };
    },

    async fetchDecisions(app, request: DecisionRequest) {
      const route = routeFor(decisionsPath, app, "paths.decisions");
      const body = await call(route, { method: "POST", body: JSON.stringify(request) });
      const record = object(body, route);
      requireContextEcho(record, route);
      return {
        app: required(record, "app", route),
        decisions: array(record, "decisions", route) as DecisionSet["decisions"],
      };
    },
  };
}

/**
 * A path segment: refused if it cannot be one, percent-encoded if it can.
 *
 * <h3>Encoding, which handles almost everything</h3>
 *
 * `encodeURIComponent` and not `encodeURI`: the latter leaves `/` and `?` alone, which is exactly
 * how an identifier escapes its segment and reaches a route nobody meant to call.
 *
 * <h3>⚠️ And the three values encoding cannot handle, which are REFUSED</h3>
 *
 * 📐 `encodeURIComponent` leaves a dot alone, and the platform's URL parser resolves dot segments
 * **before the request goes out**. Measured against a real HTTP server, with the default path:
 *
 *     id     sent as                          the server received             escapes
 *     -----  -------------------------------  ------------------------------  -------
 *     ".."   /api/me/apps/../permissions      /api/me/permissions             yes
 *     "."    /api/me/apps/./permissions       /api/me/apps/permissions        yes
 *     ""     /api/me/apps//permissions        /api/me/apps//permissions       no
 *     "..."  /api/me/apps/.../permissions     /api/me/apps/.../permissions    no
 *     "a..b" /api/me/apps/a..b/permissions    /api/me/apps/a..b/permissions   no
 *     "a/b"  /api/me/apps/a%2Fb/permissions   /api/me/apps/a%2Fb/permissions  no
 *
 * 🔴 The request leaves **with the `Authorization` header** toward a route the caller did not write.
 * The core discards the answer, because the `app` will not match — but the request already happened.
 *
 * 📐 **And encoding the dots is not a fix.** The parser percent-decodes before it resolves, so
 * `%2e%2e` and `%2E%2E` reach the same `/api/me/permissions` that `..` does. Measured. The only
 * faithful answer is to refuse the value.
 *
 * The empty string is refused for a different reason, and not a security one: it occupies NO
 * segment, so `/me/apps//permissions` is a differently shaped route rather than a route for an
 * application. The guarantee this function exists to make is "the id is exactly one segment", and
 * that cannot be said of a value that is none.
 *
 * <h3>Why here</h3>
 *
 * This is the one place an id becomes a path segment, and it runs BEFORE
 * {@link HttpTransportConfig.paths} sees the value — so a configured path cannot walk around it, and
 * neither can a future second route. The core builds no URL and has no reason to know that a dot is
 * special in one.
 */
function segment(value: string): string {
  // A `RangeError` and not an `AuthorizationTransportError`: no request was made and nothing is
  // unavailable. 📐 Through a core session the two are indistinguishable — both give `UNAVAILABLE`,
  // both deny, neither prints anything — so the choice rests entirely on the direct caller and on
  // code that catches by type. `AuthorizationTransportError` would tell a consumer's retry logic
  // that a backend is down, about a request that was never sent and can never succeed.
  if (value === "" || value === "." || value === ".." || value.includes("/")) {
    throw new RangeError(
      `the application id ${JSON.stringify(value)} cannot be a path segment: ` +
        `"." and ".." are resolved away by the URL parser, "" occupies no segment, ` +
        `and a "/" is a separator that a proxy can decode back into one`,
    );
  }
  return encodeURIComponent(value);
}

/** The paths this package used to hardcode. They are the defaults and nothing else. */
const defaultPermissionsPath = (encodedApp: string): string => `/me/apps/${encodedApp}/permissions`;
const defaultDecisionsPath = (encodedApp: string): string => `/me/apps/${encodedApp}/decisions`;

/**
 * A path is joined to the base URL verbatim, so it must begin with `/`.
 *
 * A `RangeError` and not an `AuthorizationTransportError`, because this is the same species of
 * mistake as a `contextHeader` with no `contextId`: the consumer configured something wrong, and no
 * server was involved.
 *
 * ⚠️ **It names the option to whoever calls this transport directly, and to nobody else.** There is
 * no diagnostic channel here or in the core, so through a session this error is caught and turned
 * into state — and 📐 measured, the state is not the same for the two options: a wrong permissions
 * path gives `UNAVAILABLE`, a wrong decisions path gives `READY` with every decision denied, because
 * a rejected chunk contributes nothing and absence reads as denial. See
 * {@link HttpTransportConfig.paths}.
 */
function requirePath(path: unknown, option: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new RangeError(`${option} must return a path beginning with "/"`);
  }
  return path;
}

/**
 * The construction-time probe, and it is deliberately timid.
 *
 * The package's rule is that a misconfiguration is rejected here and not at the first call, because
 * one that surfaces only when a route is exercised is met in an environment rather than in a test.
 * A function cannot be inspected the way a string can, so it is CALLED once, with an id that is
 * already percent-encoded exactly as a real one would be.
 *
 * **It only ever concludes from a returned string.** If the function throws, or returns anything
 * else, this learns nothing and says nothing: a path that is looked up by application id is entitled
 * not to know an id it has never been given, and rejecting that would turn a working configuration
 * into a construction error. What it does catch is the shape that cannot be looked up — a template
 * missing its leading slash — which is the mistake this is for.
 */
function probePath(path: ((encodedApp: string) => string) | undefined, option: string): void {
  if (path === undefined) {
    return;
  }
  let probed: unknown;
  try {
    probed = path(segment("probe"));
  } catch {
    return;
  }
  if (typeof probed === "string") {
    requirePath(probed, option);
  }
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
