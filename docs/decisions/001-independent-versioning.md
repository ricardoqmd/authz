# ADR-001: Independent per-package versioning; `authz-core` as a peer dependency

**Date:** 2026-09-20  
**Status:** Accepted

## Context

The repository holds four packages. `authz-core` carries the contract: the decision
vocabulary, the render rule and the permissions session. The other three are satellites of
that contract — `authz-context` adds the authorization context a subject works under,
`authz-http` is a reference transport over `fetch`, and `authz-react` binds a session to
React. The dependency graph is a star, not a chain: `authz-context` and `authz-http`
declare `authz-core` and nothing else, and `authz-react` declares `authz-core` and
`authz-context`. No satellite is built on another satellite's behaviour.

Up to `0.2.0` the three published packages moved together. That lockstep was never
mechanical — `.changeset/config.json` has an empty `fixed` and an empty `linked` list. It
was a habit: one changeset naming all three, so every release bumped all three whether or
not all three had changed. The cost was invisible while the contract and its two satellites
changed for the same reasons. It stops being invisible with a fourth package: a
React-only fix would publish a new `authz-http` whose changelog entry describes work that
never touched it, and whose consumers upgrade for nothing.

The coupling that is real is not satellite to satellite. It is **each package to the version
of the core contract it targets**, and the code already says so: `authz-core` is a
`peerDependency` of the three satellites, with a `workspace:*` dev-dependency for the local
link.

## Decision

**Each package versions independently.** A changeset names only the packages whose own API
or behaviour changed. There is no unified repository version number.

Contract coupling is expressed **only** through the peer range. Raising a peer range is a
hand edit in that package's `package.json`, made in the same changeset that consumes the new
contract — the version step does not rewrite peer ranges, and a package whose literal range
is not raised by hand comes out of it wrong.

Adopting a **new major of `authz-core`** (moving the peer from `^1` to `^2`) is, by
convention, a major of the adopting package — but each one does so on its own schedule.
The invariant for the consumer: every `@ricardoqmd/authz-*` package in the tree agrees on the
same `authz-core` major. `authz-core` as a peer is what guarantees a **single contract in
the runtime** — one copy in the consumer's tree, so the `PERMIT` the transport parsed is the
`PERMIT` the React guard compares.

The first release under this decision is `authz-react@0.1.0`, published alone, with the
other three staying at `0.2.0`.

### The pre-1.0 caveat

A caret range over a `0.x` version does not admit the next minor: `^0.2.0` does not admit
`0.3.0`. So while the repository is pre-1.0, a **minor of `authz-core`** invalidates the
declared range of every satellite, and every satellite must raise its peer and release.
Independence is therefore real today for satellite-only changes, and not for core minors: a
core minor is a coordinated release **by construction**, not by habit. Full independence
arrives at `1.0.0`, where `^1.0.0` admits every later `1.x`.

### The condition that makes this safe

Tests run over the workspace link, which always resolves to the newest source in the
repository. A satellite can use something introduced in `authz-core@0.3.0` while declaring
`^0.2.0`, and the suite stays green: the declared range is never exercised. Independent
versioning multiplies the combinations that hides.

The condition attached to this decision is a CI job that installs each package against the
**lowest version its declared range admits** — published tarballs, not the workspace link —
and runs that package's tests there. Until that job exists, a declared range is a claim and
not a measurement.

The decision is taken before the job exists because the failure it hides fails closed: a
missing export breaks the build or throws at the consumer. It does not widen what anyone is
allowed to do.

## Alternatives considered

- **Keep the habit — one changeset naming every package.** A single number is easy to talk
  about, and it was free while the packages changed for the same reasons. Rejected on two
  counts: it publishes versions with no content, and being a habit rather than a rule it
  fails silently — the day a package is left out of the changeset it simply does not ship,
  and nothing reports it.
- **Make the lockstep mechanical with a `fixed` group.** This would at least turn the habit
  into a rule that cannot be forgotten. Rejected because it makes the harm compulsory instead
  of accidental: it would release a React-only fix as a new version of the HTTP transport,
  forever.
- **Group `authz-core` with `authz-context` and release the rest independently.** Rejected
  for asymmetry that the code does not support: `authz-context` does not sit closer to the
  contract than `authz-http` does — both declare `authz-core` and nothing else.
- **`authz-core` as a regular dependency instead of a peer.** It allows independence too,
  but it permits two copies of the contract in one tree. Two copies means two decision
  vocabularies, and a decision produced against one is compared against the other. Rejected:
  the whole library exists to make that comparison trustworthy.

## Consequences

**Positive:**

- A package's changelog describes that package. A satellite fix ships without touching the
  others.
- A single `authz-core` in the consumer's tree, guaranteed by the peer range rather than by
  discipline.
- New bindings — a Vue binding is on the roadmap — scale without rethinking how versions
  move.

**Negative:**

- Pre-1.0, a core minor drags every satellite anyway (see the caveat). The independence
  gained today is partial and the record should not be read as more.
- Every package that must ship needs **its own** changeset, every time. A package left out
  of the changesets is a package that does not publish, and the release ends without saying
  so.
- Consumers no longer see one number covering the set, and have to read four changelogs.
- Until the range-verification job exists, a declared peer range is unverified.

## Revisit if

- Coordinating peer ranges across packages costs more than the independence is worth.
- A reason to distribute a meta-package with a single number appears.
