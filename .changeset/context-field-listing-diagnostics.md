---
"@ricardoqmd/authz-core": minor
"@ricardoqmd/authz-context": minor
"@ricardoqmd/authz-http": minor
---

Three additions. For a consumer whose options objects carry neither key — `contextField` or `onDiagnostic` —
as their own or through their prototype, and do not throw when either is read, every call answers, throws,
sends and settles as it did on `0.1.0`, and a key they carry either way is read as that option. What changes
for everyone: `ContextSession` declares `lastListedContexts()`, so an object or a class of your own declared
as a `ContextSession` needs that method.

- `@ricardoqmd/authz-http`: `contextField`, the field of an answer that must echo `contextId`, and
  `"contextId"` when omitted. The name changes where the echo is read and nothing about how it is
  judged: an answer is used only when that field, read once, is a string equal to `contextId`.
- `@ricardoqmd/authz-context`: `lastListedContexts()`, the contexts as of the last listing, beside the
  state and not inside it: `undefined` when no list is held, and a new array on every call.
- All three: `onDiagnostic`, an optional callback told why something did not happen. Each event is a
  frozen object with a `kind` and fields that hold only values the package built, handed over in a
  task of its own; what the callback throws is discarded.

**Not an addition, and not a change of behaviour: what two packages declare they run against.**
`@ricardoqmd/authz-context` and `@ricardoqmd/authz-http` now declare `@ricardoqmd/authz-core` `^0.2.0` as
their peer, where `0.1.0` declared `^0.1.0`: the three are released together, and that range names the
combination they are released as.

- **On `0.1.0`, update the three together**, to `0.2.0`. Under the range `npm install` and `pnpm add` write,
  `^0.1.0`, doing nothing keeps `0.1.0`: that range does not reach `0.2.0`, and an install or an update
  within it stays there. A range such as `0.x` or `*` does reach it.
- **An object or a class of your own declared as a `ContextSession` needs `lastListedContexts()` in the same
  change as the update:** the contexts as of the last listing, or `undefined` when no list is held. Not
  before it: on `0.1.0`, an object literal declared as a `ContextSession` does not type-check with that
  method either.
- **An options object that throws when a property it does not have is read now throws at construction**,
  where `0.1.0` constructed: each constructor reads one more property of its options object, two for
  `createHttpTransport`.
- **An install that leaves one of them on another minor ends one of four ways, depending on the installer
  and its configuration:** refused, and nothing changes; installed, with a warning; installed, without a
  word; or it ends in an error, with the mix installed anyway. In that mix a session over the transport,
  its decisions, a refused menu and a context session behave as on `0.1.0`, and what `0.2.0` added is
  missing wherever a package is still on `0.1.0`: an option given to it is ignored when the code runs — a
  `contextField` given to `@ricardoqmd/authz-http` `0.1.0` leaves the echo read from `contextId`, so an
  answer is used or refused on that field and not on the one named — and a method it does not have throws a
  `TypeError`. The types say so for a method, and for an option only when it is written in an object literal
  where the configuration is expected.
