# @ricardoqmd/authz-react

## 0.1.0

### Minor Changes

- d7cee90: The React binding for `@ricardoqmd/authz-core` and `@ricardoqmd/authz-context`. `AuthzProvider` builds,
  starts and closes the session; `useAuthz`, `usePermissionEffect`, `usePermission`, `useDecisions` and
  `PermissionGuard` read it; `useAuthzSession` returns the session itself.

  - The snapshot the hooks read is the same object until the session publishes a different state.
  - A change to `app`, `maxPairsPerRequest`, `maxCachedDecisions`, or to whether `contextTransport` is given,
    builds a new session. A transport or a callback written inline builds none.
  - `useDecisions` identifies a request by its content, and answers `DENY` for everything but the answer to the
    request it was last given, asked since the provider last became `READY`.
  - Every hook, and `PermissionGuard`, throws outside a provider.

  Its peers are `@ricardoqmd/authz-core` and `@ricardoqmd/authz-context` `^0.2.0`, and `react`
  `^18.0.0 || ^19.0.0`.
