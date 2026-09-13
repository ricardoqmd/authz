---
"@ricardoqmd/authz-core": minor
"@ricardoqmd/authz-http": minor
---

First release of `@ricardoqmd/authz-core` and `@ricardoqmd/authz-http`.

`@ricardoqmd/authz-core` answers one question: **what may this subject do in this application?** It
holds no identity and performs no authentication. The consumer implements `AuthorizationTransport` —
`fetchPermissions(app)` and `fetchDecisions(app, request)` — and the package turns those two answers
into a session and a decision cache. The port takes no subject, no role and no token, so the library
can never assert who anybody is.

`createAuthorizationSession` exposes a state machine that keeps five situations apart, and keeping
them apart is the point:

- `IDLE` — nobody has started it, or it has been closed.
- `LOADING` — a call is in flight.
- `READY` — a menu arrived. **A `READY` with an empty menu means "you may enter and may do
  nothing"**, which is a different screen from the next one.
- `NO_ACCESS_IN_APP` — the decision point said this subject may not enter.
- `UNAVAILABLE` — no answer was obtained. This is not an expired session, and it carries no
  `reason`: the package does not propagate transport text it cannot vouch for onto a screen.

`decide(request)` batches decisions and answers through `decisionFor`, which defaults to `DENY`. A
response labelled with another application is discarded whole, a pair that was not asked for is
discarded, and discarding is silent and fail-closed. A pair that comes back more than once — within a
response or across two chunks — collapses under deny-overrides (`DENY` > `CONDITIONAL` > `PERMIT`)
before anything is returned or cached, and an effect outside the declared union collapses
restrictively and does not render. Cache and pair keys are length-prefixed, so no identifier
containing a separator can forge another pair's key. The cache is bounded by `maxCachedDecisions`
(default `5000`, oldest-first eviction).

`isRenderable` is an allowlist: `PERMIT` and `CONDITIONAL` render, everything else does not.
`CONDITIONAL` renders on purpose — hiding an action because the answer is "it depends" turns
*depends* into *no*, and an invisible button tells the user nothing while a refusal message does.

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

The decisions request declares `Content-Type: application/json`; the permissions request, which has no
body, declares none. Across origins in a browser this affects all four configurations: measured in
Chrome 152 and Firefox 151, the preflight now asks for `content-type`, and a backend whose
`Access-Control-Allow-Headers` does not name it fails the preflight — the `POST` never leaves, nothing
says so, and the screen is `READY` with every decision reading `DENY`. **Allow `Content-Type` before
updating.** The README has the detail.

It **reads `app` out of the response body** rather than filling it in from what it asked — filling it
in would make the core's own check tautological — and rejects a body that is missing a field by naming
the field and the route. `403` classifies as
`NO_ACCESS_IN_APP` and everything else as `UNAVAILABLE`, overridable through `classifyError`, which
sees the parsed body; a `classifyError` that throws is treated as one that returned nothing.

An optional context pair, `contextId` and `contextHeader`, must be supplied together or not at all.
Supplied, the header carries the id and a response that does not echo it is rejected; omitted, no
header is sent and no echo is required — so a backend that has never heard of authorization contexts
works unchanged, which is the default. Supplying one without the other is a `RangeError` at
construction naming the missing one.

**No response body, token or header value ever reaches a thrown message.**

The refusal is pinned by the ids that motivated it and not by single characters — `a/b`, `../secret`,
`../..`, `/a`, `a/`, `..;`, `a;b`, `a?b`, `a#b`, `a b`, `a@b`, `a:b`, `%2e%2e`, `%2f`, `a%b`, `a+b`, an
empty id, `.`, `..` and one outside ASCII, each on both calls through all three route shapes, asserting
that nothing was sent — and by the other half, which is the one that keeps a security rule from
over-refusing: `"..."`, `"a..b"` and seven other unreserved ids are sent, reach the wire unchanged, and
their URLs are compared. Measured over a 75-id battery against the previous behaviour: 33 ids stopped
being sent, **none started**, and no accepted id's URL changed.

A value that is not a string is refused too — `undefined`, `null`, a number, an array — because
the rule is checked on the value that is sent and not on its conversion to a string; before that
check, `[".."]` passed and reached the route above with the `Authorization` header.

`encodeURIComponent` stays behind the rule as defence in depth, and its witness is the claim that
it is the IDENTITY for every accepted id. That is deliberate and it is stated in the source: measured,
it alters 0 of the 66 characters the rule admits, so removing it or swapping it for `encodeURI` produces
a function no test can distinguish from this one. Whoever widens the rule is told there, in the comment
next to the call, that the encoder has no witness beyond identity.
