export type { DecisionEffect, PermissionEntry, Decision } from "./decision.js";
export { isRenderable, decisionFor, permissionFor } from "./decision.js";

export type {
  AuthorizationContext,
  AuthorizationTransport,
  DecisionRequest,
  DecisionSet,
  PermissionMenu,
  TransportErrorKind,
} from "./transport.js";
export { AuthorizationTransportError } from "./transport.js";

export { splitDecisionRequest } from "./batch.js";

export type {
  AuthorizationSession,
  AuthorizationSessionOptions,
  AuthorizationState,
} from "./session.js";
export { createAuthorizationSession } from "./session.js";

export type { ContextSignal, ContextStore } from "./context-sync.js";
