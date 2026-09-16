# @ricardoqmd/authz-http

## 0.1.0

### Minor Changes

- fc599d2: First release of `@ricardoqmd/authz-core` and `@ricardoqmd/authz-http`.

  `@ricardoqmd/authz-core` answers one question: **what may this subject do in this application?** It
  holds no identity and performs no authentication. The consumer implements `AuthorizationTransport` —
  `fetchPermissions(app)` and `fetchDecisions(app, request)` — and the package turns those two answers
  into a session and a decision cache. The port takes no subject, no role and no token, so the library
  can never assert who anybody is.

  `createAuthorizationSession` exposes a state machine that keeps five situations apart, and keeping
  them apart is the point:

  - `IDLE` — nobody has started it, or it has been closed.
  - `LOADING` — a call is in flight.
  - `READY` — a menu arrived and is in use: it holds one entry for each action the menu names. **A
    `READY` with an empty menu means "you may enter and may do nothing"** and nothing else: it is the
    decision point's answer `permissions: []`, which is a different screen from the next one.
  - `NO_ACCESS_IN_APP` — the decision point said this subject may not enter.
  - `UNAVAILABLE` — no usable answer was obtained, including a menu that arrived with entries of which
    none names its action, or with one entry that could not be read at all. This is not an expired session,
    and it carries no `reason`: the package does not propagate transport text it cannot vouch for onto a
    screen.

  `decide(request)` batches decisions and answers through `decisionFor`, which defaults to `DENY`.
  **Identifiers are strings.** A request whose `resourceType`, an action or a resource id is not a
  string — a number, a boxed string, `null` — is refused with a `RangeError` naming the field, before the
  cache is read or the transport is called, so a caller's programming error shows on the first call
  instead of reaching the backend and coming back as a silent `DENY`. `RangeError` is the class every
  deliberate refusal of a caller's mistake in these packages uses, `@ricardoqmd/authz-http` included.
  Nothing is coerced. A session that answers nothing — idle, closed, or without access to the app —
  returns the empty list without judging the request; a loading, ready or unavailable one judges it.
  **The request is read once, when the call is made**: changing the object while its answers are in
  flight changes nothing about that call, and the decisions returned are the caller's to keep — writing
  into them changes no later answer. Each answer element and each menu entry is copied where it is
  checked, so a transport that reuses an object it already returned cannot rewrite a cached decision or
  a menu already on screen.
  **A transport returns data.** Whatever it returns is read once and judged as it was read — a field
  named `__proto__` in a parsed JSON body is a field, changing the transport's objects or their prototype
  afterwards changes no decision already given, and the length of a list is asked once more, only to tell
  whether it grew while it was read — and what cannot be read is not used. What the
  package hands back is a copy: it is not the object the transport returned, and whatever an object keeps
  outside its own fields — private fields, state held elsewhere for that instance — does not survive the
  copy.
  A chunk that fails leaves absent the pairs only it asked for, and nothing else — absent is `DENY` —
  and nothing from it is cached: a chunk fails when asking for it throws or rejects, when what it
  resolves to holds no list — it is `null` or `undefined`, or reading its `decisions` gives one of them —
  or when its `app` is not this application. A pair is answered by a chunk that asked for it — by any of
  them, when a request that names an identifier twice asks it in more than one — and what another chunk
  of the same call says about it can make it more restrictive, and cannot answer it. Each decisions
  answer a transport returns carries the pairs its own request asked for; the port says so, for a
  transport that groups calls. An answer whose `decisions` is present — not `null`, not `undefined` — and
  is not an array, such as a page of results, a map serialised as an object, `{}` or a string, leaves
  every pair of the call `DENY`, silently and on every call, and the port says that too, for a transport
  written by hand. `decide()` rejects only for a request that is refused, or that throws
  while it is read — with what it threw — or for a `maxPairsPerRequest` the splitter refuses. What
  cannot be read at all is not discarded: an answer element that throws when its `action` or
  `resourceId` is read, when the list is read at its position, or when it is asked for its keys, a key's
  descriptor or its prototype may be the `DENY` for a pair another element permits, so the call resolves
  with the empty list and caches nothing, and a menu entry like it makes the session `UNAVAILABLE`. So do
  an element that is a function, a position the list gained while it was being read, and an answer whose
  envelope throws when read, that is a function, or whose `decisions` is present, not `null` or
  `undefined`, and is not an array — a `Set`, a `Map`'s values, an array-like: a list is read only when it
  is an array.
  A pair that was not asked for is discarded, an answer whose `app` is not this application is
  discarded whole, and discarding is silent and fail-closed. An element that names no pair — `null`,
  `undefined`, or one whose `action` or `resourceId`, read, is not a string — is dropped the same way,
  and nothing else with it. An element that names its pair with no string `effect` reads
  `DENY`, and so does `decisionFor` on an array assembled by hand; `permissionFor` applies the same
  rule to a menu. Both lookups read every element: a pair listed more than once reads as the most
  restrictive of the elements that name it, and an element that is a function makes every pair `DENY`. **Neither lookup ever throws**: they are read while a screen is drawn, so a collection
  that is not an array reads `DENY` too — `permissionFor(state.permissions, action)` on a state that is not
  `READY` included — and so does anything that throws while they look: a revoked `Proxy`, a `find` that
  throws, an element whose `effect` throws when read. A menu whose `permissions`, read, is not an
  array is `UNAVAILABLE`, and so is one whose envelope throws when it is read; the envelope of each
  answer is read once, and the list it carried is read once, by index — its length is read once more
  afterwards, only to tell whether the list grew while it was read. `READY`
  holds one entry for each action the menu names with a string, and a menu that arrived with entries
  and named no action is `UNAVAILABLE` rather than `READY` with an empty menu. A menu entry is identified by its
  `action` alone: fields the type does not declare do not keep two entries apart, and on a tie the first
  entry is kept whole. A pair that comes back more than once —
  within a response or across two chunks — collapses under deny-overrides (`DENY` > `CONDITIONAL` >
  `PERMIT`) before anything is returned or cached. An action a menu lists more than once collapses the
  same way, and an effect outside the declared union collapses restrictively and does not render.
  Cache and pair keys are length-prefixed, so no identifier containing a separator can forge another
  pair's key. The cache answers a pair with what the last call that asked for it returned, and with
  nothing else: a pair a call leaves absent is absent from the cache too, and the next call that asks for
  it asks the decision point. Of two calls in flight at once that ask for one pair, the last is the one
  answered last. The price is paid on a connection that drops requests: a request is served from the
  cache only once one call has answered every pair of it, and a call that finds any pair missing asks for
  the whole request again, so a request of many chunks is asked, and shows the pairs of its failed chunks
  as `DENY`, on every draw until one call completes. The core README has the measured cost, and the two
  things that bring it back: asking for what is drawn, and a transport that asks a failed request once
  more. The cache is bounded by `maxCachedDecisions` (default `5000`, oldest-first eviction).

  `isRenderable` is an allowlist: `PERMIT` and `CONDITIONAL` render, everything else does not.
  `CONDITIONAL` renders on purpose — hiding an action because the answer is "it depends" turns
  _depends_ into _no_, and an invisible button tells the user nothing while a refusal message does.

  `@ricardoqmd/authz-http` is a reference transport over `fetch`, built by `createHttpTransport`.
  Everything is configuration: the base URL, how a token is obtained, `fetch` itself — injectable and
  defaulting to the global — and the two routes, through an optional `paths`, which defaults to
  `/me/apps/{app}/permissions` and `/me/apps/{app}/decisions`. The application id reaches a configured
  path already percent-encoded, so configuring a route cannot hand that guarantee to the caller, and an
  application id is refused with a `RangeError` before anything is sent unless it is a non-empty sequence
  of RFC 3986 `unreserved` characters — letters, digits, `-`, `.`, `_`, `~` — that is neither `"."` nor
  `".."`. It is a whitelist rather than a list of values measured harmful, because the list was the
  defect: a dot segment is resolved away by the URL parser, a `%2F` is decoded back into a
  separator by nginx with a URI part in `proxy_pass` and by Apache with `AllowEncodedSlashes On`, and
  a `%3B` is decoded by that nginx and by Apache in every configuration measured but `nocanon` —
  after which a Servlet container strips `;parameters` and resolves the `..`, so `"..;"` reached an
  upstream as `/me/permissions` with the `Authorization` header, through a character no list named.
  What the package guarantees is still the segment in the URL it constructs; what changed is that no
  accepted id contains a character any measured front door transforms, so that segment survives
  them. The README has the measurements, and says which proxy settings actually preserve a
  segment.

  The decisions request declares `Content-Type: application/json`; the permissions request, which has
  no body, declares none. Across origins in a browser this affects all four combinations of a token
  and the context pair: measured in Chrome 152 and Firefox 151, the preflight now asks for
  `content-type`, and a backend whose `Access-Control-Allow-Headers` does not name it fails the
  preflight — the `POST` never leaves, nothing says so, and the screen is `READY` with every decision
  reading `DENY`. **Allow `Content-Type` before updating.** The README has the detail.

  It **reads `app` out of the response body** rather than filling it in from what it asked — filling it
  in would make the core's own check tautological — and rejects a body that is missing a field by naming
  the field and the route. `403` classifies as
  `NO_ACCESS_IN_APP` and everything else as `UNAVAILABLE`, overridable through `classifyError`, which
  sees the parsed body; a `classifyError` that throws is treated as one that returned nothing.

  An optional context pair, `contextId` and `contextHeader`, must be supplied together or not at all.
  Supplied, the header carries the id and a response that does not echo it is rejected; omitted, no
  header is sent and no echo is required — so a backend that has never heard of authorization contexts
  works unchanged, which is the default. The configured header name is set on the headers handed to
  `fetch` as a field of its own, whatever the name is. Supplying one without the other is a `RangeError` at
  construction naming the missing one.

  **No response body, token or header value ever reaches a thrown message.**

  The refusal covers the ids that motivated it and not only single characters — `a/b`, `../secret`,
  `../..`, `/a`, `a/`, `..;`, `a;b`, `a?b`, `a#b`, `a b`, `a@b`, `a:b`, `%2e%2e`, `%2f`, `a%b`, `a+b`, an
  empty id, `.`, `..` and one outside ASCII, each refused on both calls through all three route shapes
  with nothing sent — and it does not over-refuse, which is the half that keeps a security rule usable:
  `"..."`, `"a..b"` and seven other unreserved ids are sent and reach the wire unchanged. Compared id by
  id with the previous behaviour over 75 ids: 33 stopped being sent, **none started**, and no accepted
  id's URL changed.

  A value that is not a string is refused too — `undefined`, `null`, a number, an array — because
  the rule is checked on the value that is sent and not on its conversion to a string; before that
  check, `[".."]` passed and reached the route above with the `Authorization` header.

  `encodeURIComponent` stays behind the rule as defence in depth. It alters none of the 66 characters
  the rule admits, so today it is the identity for every accepted id, and removing it or swapping it for
  `encodeURI` would send exactly the same URLs. That is deliberate and it is stated in the source, in the
  comment next to the call, for whoever widens the rule.

### Patch Changes

- Updated dependencies [fc599d2]
  - @ricardoqmd/authz-core@0.1.0
