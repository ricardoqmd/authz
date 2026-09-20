# @ricardoqmd/authz-react

**The React binding for [`@ricardoqmd/authz-core`](https://github.com/ricardoqmd/authz/tree/main/packages/authz-core)
and [`@ricardoqmd/authz-context`](https://github.com/ricardoqmd/authz/tree/main/packages/authz-context).** A
provider that builds, starts and closes the session, hooks that read it, and a guard.

> **Status: pre-1.0.** The public surface may change in minor versions until `1.0.0`.

It holds what has to be right in one place for every screen: the snapshot `useSyncExternalStore` reads
stays the same object while the state has not changed, and a transport or a callback written inline
builds no session. What it does not decide, it hands over: `useAuthzSession()` returns the session
itself.

**This package knows nothing about HTTP.** It builds no transport, and its code names no route, header,
HTTP status or body. The transports are yours, as they are for the packages below it.

## Install

```bash
pnpm add @ricardoqmd/authz-react @ricardoqmd/authz-core @ricardoqmd/authz-context
```

`@ricardoqmd/authz-context` is a peer whether or not your application has contexts. The peers are
`@ricardoqmd/authz-core` and `@ricardoqmd/authz-context` `^0.2.0`, and `react` `^18.0.0 || ^19.0.0`.

## Usage

```tsx
import { AuthzProvider, PermissionGuard, useAuthz, useDecisions } from "@ricardoqmd/authz-react";
import { createHttpTransport } from "@ricardoqmd/authz-http";

function App() {
  return (
    <AuthzProvider
      app="app-a"
      maxPairsPerRequest={100}
      transport={(contextId) =>
        createHttpTransport({
          baseUrl: "https://api.example.com",
          getToken: () => auth.accessToken ?? null,
          contextId,
          contextHeader: contextId === undefined ? undefined : "X-Context-Id",
        })
      }
      contextTransport={myContextTransport}
      onInvalidated={(refresh) => http.onForbidden(refresh)}
    >
      <Screen />
    </AuthzProvider>
  );
}

function Screen() {
  const { status, contexts, selectContext } = useAuthz();
  const rows = useDecisions({ resourceType: "doc", actions: ["edit"], resourceIds: ["d-1", "d-2"] });
  // ...
  return (
    <PermissionGuard action="doc:create" fallback={null}>
      <button type="button">New</button>
    </PermissionGuard>
  );
}
```

The functions and objects written inline above are new values on every render, and none of them builds a
session.

## The provider

| Prop | |
|---|---|
| `app` | The application being asked about. |
| `transport` | An `AuthorizationTransport`, or a function that returns one for a context. It is called once for each permissions session built: with the context's id under a context, and with `undefined` otherwise. |
| `contextTransport` | Given when the application has contexts. The provider then builds a `ContextSession`; without it, an `AuthorizationSession`. |
| `maxPairsPerRequest` | Passed to each permissions session. **It has no default here either**: without it, every `useDecisions` lookup answers `DENY`, because the core refuses to split the request. |
| `maxCachedDecisions` | Passed to each permissions session, and checked by the core when one is built, so a value it refuses surfaces where that session is built: without contexts the provider's render throws, and with contexts no session is built and the status does not reach `READY`. |
| `onDiagnostic` | Passed to every permissions session the provider builds. The context session is built without one, so the events of `@ricardoqmd/authz-context` reach no callback in this version. |
| `onInvalidated` | Called with a function that refreshes and returns what `refresh()` returns; returns the function that unsubscribes, which is called on unmount. This is how whatever learns that the authorization held is stale tells the provider. |

**Which props build a session.** A change to `app`, `maxPairsPerRequest`, `maxCachedDecisions`, or to
whether `contextTransport` is given, builds a new session and closes the one it replaces. `transport`,
`contextTransport` and `onDiagnostic` are read when a session is built, and a new value in any of them
builds none: the next session built uses it, and `refresh()` builds one now. `onInvalidated` is registered
once while it is given, and a new function in it is not registered.

**The session is started by the provider and closed on unmount.**

## The state: `useAuthz()`

```ts
const { status, contextId, contexts, permissions, selectContext, refresh } = useAuthz();
```

| `status` | |
|---|---|
| `LOADING` | The session has not settled, or it entered a context whose menu has not arrived. |
| `CHOOSING_CONTEXT` | Several contexts; one has to be chosen. |
| `NO_CONTEXTS` | The subject holds no context. |
| `NO_ACCESS_IN_APP` | The decision point, or the context entered, does not open this application. |
| `READY` | The menu arrived. |
| `UNAVAILABLE` | No usable answer: the menu, or the list of contexts, could not be obtained. |

A session without contexts is shown in the same shape, and never reaches `CHOOSING_CONTEXT` or
`NO_CONTEXTS`.

- **`permissions` is the menu while `READY`, and empty in every other status.**
- **`contexts` is what the context session's `lastListedContexts()` returns**, and an empty list when it
  returns none. It is still there once a context is entered, so a picker in a header keeps its list.
- **`contextId`** is the context the session is in, and absent while it is in none.
- **`selectContext(id)`** enters a context and settles when it has, and otherwise rejects with a
  `RangeError`: on a provider given no `contextTransport`, for an id the last listing did not return, and
  whenever the session it would act on is no longer the one in use — during a `refresh()`, after a change
  of `app`, or once an effect has closed it. A `transport` factory that throws rejects the call with what it
  threw.
- **`refresh()`** builds a new session, closes the one in use, and settles once the new session has
  settled. With contexts, the new session lists them again, so a subject with several chooses again; to
  return to the same one, await it and then `selectContext`.
- **In a test, start `refresh()` inside `act()` and await it after `act()` has returned**, and the same for
  the function given to `onInvalidated`. Awaited or returned inside the `act()` callback that started it,
  its promise does not settle, and the test runs until it times out.

## Permissions: `usePermission`, `usePermissionEffect`, `PermissionGuard`

```ts
usePermissionEffect("doc:create"); // "PERMIT" | "DENY" | "CONDITIONAL"
usePermission("doc:create");       // whether it is rendered
```

**`PERMIT` renders, `DENY` does not, `CONDITIONAL` renders.** Hiding an action because the answer is "it
depends" turns *depends* into *no*. An action the menu does not name is `DENY`. `PermissionGuard` renders
its `children` when the action renders, and its `fallback` otherwise.

**Until `READY`, every permission is `DENY`**: the menu is empty in every other status.

## Decisions: `useDecisions`

```ts
const lookup = useDecisions({ resourceType: "doc", actions: ["edit"], resourceIds: ids });
lookup.can("edit", "d-1");      // whether it is rendered
lookup.effectOf("edit", "d-1"); // the effect
lookup.isLoading;
```

Ask once for the page, never once per row. Pass `null` to ask nothing.

- **A request is identified by its content**: an equal request written inline on every render is asked
  once.
- **A lookup answers from the answer to the request it was last given, asked since the provider last
  became `READY`, and `DENY` for everything else.** Nothing is asked while the provider is not `READY`.
  So after `refresh()` or `selectContext()`, a lookup that answered before answers `DENY` until the new
  answer arrives, and never with what the previous session or context answered.
- **An answer to an earlier request is not used**, whatever order the answers arrive in.
- **A request the session refuses answers `DENY`**, and nothing is thrown.
- `isLoading` is `true` while a request is given, the provider is `READY`, and the session has neither
  answered nor refused it.

## The session itself: `useAuthzSession()`

Returns the session in use: a `ContextSession` when the provider was given a `contextTransport`, an
`AuthorizationSession` otherwise. It is a different object after `refresh()`. Use it for what this package
does not do.

**The provider owns its lifetime**: it starts it, and closes it when it is replaced or unmounted. Closed by
anything else, it stays in place and can no longer answer: every permission reads `DENY`, and
`selectContext(id)` resolves without entering.

## Outside a provider

**Every hook throws**, and so does `PermissionGuard`. A permission read without a provider has no session
to answer from, and any value it returned would read as an answer: `false` as a denial, `true` as a grant.

## License

MIT © ricardoqmd
