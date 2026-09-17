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
   * The field of the response body that must echo {@link contextId}. **Optional; `"contextId"` when
   * omitted.** Read only when `contextId` is supplied.
   *
   * **Configuration and never a constant, for the same reason as {@link contextHeader}:** a backend
   * that echoes the context under another name is not wrong, and a name baked in here would reject
   * every one of its answers.
   *
   * The name changes where the echo is read and nothing about how it is judged: an answer is used only
   * when that field, read once, is a string equal to `contextId`. A missing field, one that is not a
   * string, and one that echoes a different context are rejected, as they are under the default name.
   *
   * It must be a non-empty string, or the constructor throws a `RangeError`: an empty name, or one
   * that is not a string, names no field an answer could carry.
   */
  readonly contextField?: string;
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
   * `encodeURIComponent` before your function sees it, and an id that is not **a non-empty sequence
   * of RFC 3986 `unreserved` characters** — `ALPHA / DIGIT / "-" / "." / "_" / "~"` — or that is
   * exactly `"."` or `".."`, is **REFUSED outright**, with a `RangeError` and no request sent. The
   * refusal runs before your function is called, so a configured path cannot walk around it. Had the
   * raw id been passed instead, that guarantee would have moved to you silently, and forgetting to
   * encode is the ordinary mistake.
   *
   * **What is guaranteed, and where it stops: the segment in the URL THIS PACKAGE CONSTRUCTS.**
   * An id occupies exactly one segment of that URL. What a front door does with it afterwards is
   * outside this package's reach — measured against `nginx 1.29.3` with
   * `proxy_pass http://upstream/api/;`, `%2F` is decoded and the dot segments re-resolved, so before
   * the rule existed `"../secret"` left here as `/api/me/apps/..%2Fsecret/permissions` and the
   * upstream received `/api/me/secret/permissions`, with the `Authorization` header. What changed is
   * the input and not the guarantee: **an accepted id can contain no `/`, no `;`, no `%` and nothing
   * outside ASCII**, so the transformations those doors perform have nothing to act on. The package
   * README has the six configurations measured, including why `AllowEncodedSlashes NoDecode` is not
   * the way out.
   *
   * **Do not encode it again.** **Measured: over the 66 characters the rule admits,
   * `encodeURIComponent` alters none**, so for every id this transport is given it is the
   * identity — and so is applying it twice. The `%252F` that a `/` used to produce cannot happen,
   * because a `/` never gets here. **The mistake is unreachable, not harmless**: it is the rule
   * keeping it unreachable, and one widening
   * away from mattering again. What it costs when it is reachable, measured through a session: a
   * double-encoded `permissions` path shows `UNAVAILABLE`, or `NO_ACCESS_IN_APP` from a backend that
   * answers `403` for an application it does not know; a double-encoded `decisions` path shows
   * `READY` with every decision denied. Nothing is printed in any of those cases.
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
   *   naming which option produced it — **for whoever called this transport**. Read the next
   *   paragraph before relying on that, because it is the part that bites: through the core, nobody
   *   is told anything, and the two paths fail differently.
   *
   * <h3>What a call-time path error looks like from ABOVE</h3>
   *
   * **Nothing names it.** The `RangeError` reaches whoever called `fetchPermissions` or
   * `fetchDecisions` directly, and no published code of any of the three packages calls `console`.
   * Through `createAuthorizationSession` it is caught and turned into state. No diagnostic event names
   * the option: {@link onDiagnostic} is told only of an `AuthorizationTransportError`, and this is not
   * one, and what a session's `onDiagnostic` hears of it is the reason `rejected`.
   *
   * And the two options do not fail alike. Measured through a real core session, with a path that
   * passes the construction probe and fails for the real id, against a backend that permits `read`
   * on `r-1`:
   *
   *     wrong option       session state   decisionFor(read, r-1)   console calls
   *     -----------------  --------------  -----------------------  -------------
   *     paths.permissions  UNAVAILABLE     PERMIT                   0
   *     paths.decisions    READY           DENY                     0
   *
   * **A wrong `paths.decisions` is the dangerous one.** The menu loads, so the screen is `READY`
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
   * <h3>A path is not a place to put a secret</h3>
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
  /**
   * Told which rule refused a call, as an {@link HttpTransportDiagnostic}. **Optional**, and nothing the
   * transport sends, returns or rejects with depends on whether it is given.
   *
   * **Called in a task of its own.** Each event is handed to it through `setTimeout`, never from inside
   * a call of this package, and nothing this package does waits for it: what it returns is not read, so
   * a promise it returns is not awaited and its rejection is not caught. Like any code, a callback that
   * blocks the thread blocks everything that runs on it.
   *
   * **What it throws is discarded**, and the transport carries on as if it had not been called.
   *
   * It must be a function, or the constructor throws a `RangeError`.
   */
  readonly onDiagnostic?: (event: HttpTransportDiagnostic) => void;
}

/**
 * What a transport tells {@link HttpTransportConfig.onDiagnostic}: which rule refused a call.
 *
 * **Data, not a message.** Every event is a new frozen object with a `kind` and the fields its kind
 * declares, and every field holds a value this package built: an operation or a reason named here. None
 * holds a token, a header, a route, a status, a body, or anything else read out of a response.
 */
export type HttpTransportDiagnostic = {
  /**
   * The call rejected with an `AuthorizationTransportError`: raised once for every call that does.
   * `operation` is the method that was called — `permissions` for `fetchPermissions`, `decisions` for
   * `fetchDecisions` — and `reason` is the rule:
   *
   * - `no-response` — no response arrived: the token could not be obtained, or the request did not
   *   complete;
   * - `status` — the response status is not in the 2xx range;
   * - `not-json` — the body is not JSON;
   * - `not-an-object` — the body is not an object;
   * - `no-app` — the body's `app` is missing or not a string;
   * - `no-list` — the body's `permissions` or `decisions` is missing or not an array;
   * - `no-context-echo` — a `contextId` was configured and the body's echo field is missing or not a
   *   string;
   * - `other-context` — that field echoes a different context.
   */
  readonly kind: "call-failed";
  readonly operation: "permissions" | "decisions";
  readonly reason:
    | "no-response"
    | "status"
    | "not-json"
    | "not-an-object"
    | "no-app"
    | "no-list"
    | "no-context-echo"
    | "other-context";
};

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
 * - **Both:** the header carries the id, and a response body whose echo field — `contextId`, or the
 *   name given as `contextField` — does not echo it is **rejected loudly**, with the same message
 *   discipline as every other rejection here — the route and the field, never the body, never the
 *   token, never the header value.
 * - **One without the other:** rejected at construction with a `RangeError` naming which is
 *   missing. A header name with nothing to put in it, or an id with nowhere to send it, is a
 *   configuration mistake, and discovering it as a `401` costs far more than discovering it here.
 *
 * <h2>Across origins in a browser, your backend must allow the `Content-Type` header</h2>
 *
 * The decisions request sends `Content-Type: application/json`, which is not a CORS-safelisted value,
 * so **the decisions call is preflighted in all four combinations of a token and the context
 * pair** — including the one with neither, where the content type is the only reason an `OPTIONS`
 * happens at all. Measured in Chrome 152 and Firefox 151 through a session: a backend whose
 * `Access-Control-Allow-Headers` does not name `Content-Type`, or that does not answer `OPTIONS`,
 * fails the preflight — and **nothing says so.** The menu request carries no content type and still
 * loads, so the screen reaches `READY` with every decision reading `DENY`, for pairs the backend
 * permits. Same-origin, neither browser sent an `OPTIONS` in any configuration.
 *
 * This warning is here, on a type a consumer hovers, and not only in the source: the fix is a change
 * to a deployment's CORS configuration, and the symptom — a working screen that denies everything —
 * gives no reason to go looking for it. The measurements behind it are in the source, next to the
 * line that sets the header.
 */
export function createHttpTransport(config: HttpTransportConfig): AuthorizationTransport {
  const { baseUrl, contextId, contextHeader, contextField = "contextId", getToken, classifyError, onDiagnostic } =
    config;
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
  // The echo field names what an answer must carry, so a name that no answer can carry is a
  // configuration mistake like the two above. The message gives the type it received and never the
  // value.
  if (typeof contextField !== "string" || contextField === "") {
    throw new RangeError(
      `contextField must be a non-empty string, received ${
        typeof contextField === "string"
          ? "an empty string"
          : contextField === null
            ? "null"
            : Array.isArray(contextField)
              ? "an array"
              : typeof contextField
      }`,
    );
  }
  const notify = notifier(onDiagnostic);
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
    // Measured against a real server before this line existed: the POST arrived as
    // `content-type: text/plain;charset=UTF-8`, a backend that requires JSON answered `415`, the
    // chunk was dropped, and the session sat at `READY` with zero decisions and `DENY` for a pair
    // the backend would have permitted — the working screen with everything denied that this file
    // warns about elsewhere.
    //
    // Keyed on the body and not on the method so that a future route with a body cannot forget it.
    //
    // IN A BROWSER, ACROSS ORIGINS, THIS AFFECTS ALL FOUR CONFIGURATIONS. Measured in Chrome
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
    //
    // The measurements stay here; the ACTIONABLE half is stated on {@link createHttpTransport}, which
    // is a doc comment and therefore reaches `index.d.ts` and a consumer's hover. This is a `//`
    // comment inside a function body: it reaches the source map and nothing else. The README says it
    // too, where a consumer will look for it.
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
      // DEFINED, not assigned: the name is the consumer's, and assigned, a header named `__proto__`
      // set the prototype of this object instead of adding a header, and was never sent. Defined, it
      // is a field of the headers handed to `fetch`; whether `fetch` sends it is the platform's, and
      // Node 20's drops a `__proto__` key from a headers object.
      Object.defineProperty(out, contextHeader, {
        value: contextId,
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
      throw refused("no-response", "UNAVAILABLE", `${route}: the request did not complete`);
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
      throw refused(
        "status",
        chosen ?? (response.status === 403 ? "NO_ACCESS_IN_APP" : "UNAVAILABLE"),
        `${route}: responded ${response.status}`,
      );
    }
    if (!parsed) {
      throw refused("not-json", "UNAVAILABLE", `${route}: the body is not JSON`);
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
    const echoed = required(record, contextField, route, "no-context-echo");
    if (echoed !== contextId) {
      throw refused(
        "other-context",
        "UNAVAILABLE",
        `${route}: the response "${contextField}" does not echo the one that was sent`,
      );
    }
  }

  /** Tells `onDiagnostic` the rule, when a call rejects with an error this transport built. */
  function notifyRefusal(operation: HttpTransportDiagnostic["operation"], error: unknown): void {
    if (notify === undefined) {
      return;
    }
    const reason = error instanceof AuthorizationTransportError ? reasons.get(error) : undefined;
    if (reason !== undefined) {
      notify({ kind: "call-failed", operation, reason });
    }
  }

  return {
    async fetchPermissions(app) {
      try {
        const route = routeFor(permissionsPath, app, "paths.permissions");
        const body = await call(route, { method: "GET" });
        const record = object(body, route);
        requireContextEcho(record, route);
        return {
          app: required(record, "app", route, "no-app"),
          permissions: array(record, "permissions", route) as PermissionMenu["permissions"],
        };
      } catch (error) {
        notifyRefusal("permissions", error);
        throw error;
      }
    },

    async fetchDecisions(app, request: DecisionRequest) {
      try {
        const route = routeFor(decisionsPath, app, "paths.decisions");
        const body = await call(route, { method: "POST", body: JSON.stringify(request) });
        const record = object(body, route);
        requireContextEcho(record, route);
        return {
          app: required(record, "app", route, "no-app"),
          decisions: array(record, "decisions", route) as DecisionSet["decisions"],
        };
      } catch (error) {
        notifyRefusal("decisions", error);
        throw error;
      }
    },
  };
}

/**
 * The characters an application id may contain: RFC 3986 `unreserved`.
 *
 * `ALPHA / DIGIT / "-" / "." / "_" / "~"`, and nothing else. The name is the standard's; the set has
 * been called `unreserved` since 2005 and means precisely "safe anywhere in a URI, with no encoding
 * and no interpretation".
 *
 * **A whitelist and not a blacklist, and that is the decision.** The four literals this replaced
 * — `""`, `"."`, `".."` and "contains `/`" — each named a value someone had measured harmful, which
 * left every character nobody had thought to measure permitted by default. That default is how `;`
 * got through: behind `nginx` with a URI part, `"..;"` reached a Servlet container as
 * `/me/permissions` **with the `Authorization` header**, because a container strips `;parameters`
 * from a segment before normalising it — the same damage that motivated refusing `/`, through a
 * character nobody had listed. A whitelist has no such default. What it costs is that an id outside
 * the set is refused whether or not it would have been harmful, and that price is known: compared id
 * by id with the rule it replaced, over 75 ids, **33 that used to be sent are refused, none that used
 * to be refused is sent, and no accepted id's URL changed** — the rule only ever closes.
 *
 * Case passes both ways, and that is deliberate: see the note on case in `segment`.
 */
const unreserved = /^[A-Za-z0-9._~-]+$/;

/**
 * A path segment: refused if it cannot be one, percent-encoded if it can.
 *
 * <h3>The refusal, and what it used to be</h3>
 *
 * `encodeURIComponent` leaves a dot alone, and the platform's URL parser resolves dot segments
 * **before the request goes out**. Measured against a real HTTP server on the default path, and
 * behind `nginx 1.29.3` with `proxy_pass http://upstream/api/;`:
 *
 *     id            sent as                               direct server got        behind that nginx  now
 *     ------------  ------------------------------------  -----------------------  -----------------  -------
 *     ".."          /api/me/apps/../permissions           /api/me/permissions      same               REFUSED
 *     "."           /api/me/apps/./permissions            /api/me/apps/permissions same               REFUSED
 *     ""            /api/me/apps//permissions             unchanged                /api/me/apps/...   REFUSED
 *     "a/b"         /api/me/apps/a%2Fb/permissions        unchanged                a/b, two segments  REFUSED
 *     "../secret"   /api/me/apps/..%2Fsecret/permissions  unchanged                /api/me/secret/..  REFUSED
 *     "../.."       /api/me/apps/..%2F../permissions      unchanged                /api/permissions   REFUSED
 *     "..;"         /api/me/apps/..%3B/permissions        unchanged                ..; decoded        REFUSED
 *     "a\b"         /api/me/apps/a%5Cb/permissions        unchanged                unchanged          REFUSED
 *     "..."         /api/me/apps/.../permissions          unchanged                unchanged          sent
 *     "a..b"        /api/me/apps/a..b/permissions         unchanged                unchanged          sent
 *
 * **The last column is the point, and the last two rows are why the rule is not "no dots".** Only
 * the exact values `"."` and `".."` are refused as dot segments; `"..."` and `"a..b"` are unreserved
 * and are sent. A column that used to be here said `escapes: yes/no` and was measured against a
 * direct server only — which made it wrong for three of its rows behind `nginx` with a URI part.
 *
 * Before the refusal, each of those requests left **with the `Authorization` header** toward a
 * route the caller did not write. The core discarded the answer, because the `app` would not
 * match — but the request had already happened.
 *
 * **And encoding the dots is not a fix.** The parser percent-decodes before it resolves, so
 * `%2e%2e` and `%2E%2E` reach the same `/api/me/permissions` that `..` does. Measured. The only
 * faithful answer is to refuse the value.
 *
 * The empty string is refused for a different reason, and not a security one: it occupies NO
 * segment, so `/me/apps//permissions` is a differently shaped route rather than a route for an
 * application. The guarantee this function exists to make is "the id is exactly one segment", and
 * that cannot be said of a value that is none.
 *
 * <h3>Encoding, which is now defence in depth and says so</h3>
 *
 * `encodeURIComponent` and not `encodeURI`: the latter leaves `/` and `?` alone, which is exactly how
 * an identifier escapes its segment and reaches a route nobody meant to call. **Since the rule
 * admits only unreserved characters, no accepted id reaches this call with anything to encode** —
 * it alters 0 of the 66 characters the rule admits. It stays because a whitelist and an encoder
 * fail differently. What it does today is be the IDENTITY for every accepted id — an encoder that
 * was not, such as `escape`, would send `a%7Eb` for `a~b` and change a URL — and that is all a
 * consumer can see of it: over the accepted set `encodeURIComponent`, `encodeURI` and no encoding at
 * all produce the same URL. It starts to matter the day the rule admits a character it would encode.
 *
 * <h3>Case, which passes both ways, and where that bites</h3>
 *
 * `unreserved` includes both `ALPHA` ranges, so `"App-A"` and `"app-a"` are both accepted — and they
 * are two DIFFERENT applications. **This package does not normalise case and must not**, because
 * it is not the component that decides what an application id means: the core compares
 * `menu.app !== app` exactly, so a backend that lowercases the id in its answer makes the core
 * discard that answer. Measured through a core session, the screen goes `LOADING` then `UNAVAILABLE`
 * with no reason printed — the same shape as a backend being down. Sending the id verbatim keeps that
 * failure the backend's and visible; normalising here would move it into this package and hide it.
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
  // unavailable. Through a core session the two are indistinguishable — both give `UNAVAILABLE`,
  // both deny, neither prints anything — so the choice rests entirely on the direct caller and on
  // code that catches by type. `AuthorizationTransportError` would tell a consumer's retry logic
  // that a backend is down, about a request that was never sent and can never succeed.
  //
  // `typeof` first, and it is the half of the rule the type cannot enforce for a JavaScript caller.
  // The pattern converts its argument to a string and the dot check compares the value itself, so
  // without this line the two halves read different things. Measured against a real server, through
  // this package's own `fetch` call: `[".."]` passed the pattern as ".." and failed `=== ".."`, the
  // encoder turned it back into "..", and the URL parser sent the request one route up, to
  // `/me/permissions`, with the `Authorization` header; `undefined` and `null` were sent as the ids
  // "undefined" and "null". It is also why the choice of encoder below makes no difference today:
  // with it, nothing but a string of unreserved characters reaches `encodeURIComponent`.
  if (typeof value !== "string") {
    throw new RangeError(
      `the application id must be a string of unreserved characters, received ${
        value === null ? "null" : Array.isArray(value) ? "an array" : typeof value
      }`,
    );
  }
  if (!unreserved.test(value) || value === "." || value === "..") {
    throw new RangeError(
      `the application id ${JSON.stringify(value)} is not usable as a path segment: ` +
        `an id must be a non-empty sequence of unreserved characters ` +
        `(letters, digits, "-", ".", "_", "~") and must not be "." or ".."`,
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
 * **It names the option to whoever calls this transport directly, and to nobody else.** Through a
 * session this error is caught and turned into state, and no diagnostic event names the option — and
 * measured, the state is not the same for the two options: a wrong permissions
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
    throw refused("not-an-object", "UNAVAILABLE", `${route}: the response is not an object`);
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
function required(
  record: Record<string, unknown>,
  field: string,
  route: string,
  reason: "no-app" | "no-context-echo",
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw refused(
      reason,
      "UNAVAILABLE",
      `${route}: the response is missing the "${field}" field, or it is not a string`,
    );
  }
  return value;
}

function array(record: Record<string, unknown>, field: string, route: string): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw refused(
      "no-list",
      "UNAVAILABLE",
      `${route}: the response is missing the "${field}" array, or it is not an array`,
    );
  }
  return value;
}

/** The rule each error this transport built was refused on, for `onDiagnostic`. */
const reasons = new WeakMap<AuthorizationTransportError, HttpTransportDiagnostic["reason"]>();

/** An error this transport rejects with, remembered with the rule that refused the call. */
function refused(
  reason: HttpTransportDiagnostic["reason"],
  kind: TransportErrorKind,
  message: string,
): AuthorizationTransportError {
  const error = new AuthorizationTransportError(kind, message);
  reasons.set(error, reason);
  return error;
}

/**
 * How a transport tells `onDiagnostic`, or `undefined` when no callback was given, and then no event is built
 * and nothing is scheduled.
 *
 * The event is handed over in a task of its own, inside a `try`: the callback is the consumer's code,
 * and neither what it throws nor how long it takes belongs to the call that raised the event.
 */
function notifier(onDiagnostic: unknown): ((event: HttpTransportDiagnostic) => void) | undefined {
  if (onDiagnostic === undefined) {
    return undefined;
  }
  if (typeof onDiagnostic !== "function") {
    throw new RangeError(
      `onDiagnostic must be a function, received ${
        onDiagnostic === null ? "null" : Array.isArray(onDiagnostic) ? "an array" : typeof onDiagnostic
      }`,
    );
  }
  const callback = onDiagnostic as (event: HttpTransportDiagnostic) => void;
  return (event) => {
    const frozen = Object.freeze(event);
    setTimeout(() => {
      try {
        callback(frozen);
      } catch {
        // Discarded. See `onDiagnostic`.
      }
    }, 0);
  };
}
