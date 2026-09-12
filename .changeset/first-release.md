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
path already percent-encoded, so configuring a route cannot hand that guarantee to the caller. It **reads `app` out of the response body** rather than
filling it in from what it asked — filling it in would make the core's own check tautological — and
rejects a body that is missing a field by naming the field and the route. `403` classifies as
`NO_ACCESS_IN_APP` and everything else as `UNAVAILABLE`, overridable through `classifyError`, which
sees the parsed body; a `classifyError` that throws is treated as one that returned nothing.

An optional context pair, `contextId` and `contextHeader`, must be supplied together or not at all.
Supplied, the header carries the id and a response that does not echo it is rejected; omitted, no
header is sent and no echo is required — so a backend that has never heard of authorization contexts
works unchanged, which is the default. Supplying one without the other is a `RangeError` at
construction naming the missing one.

**No response body, token or header value ever reaches a thrown message.**
