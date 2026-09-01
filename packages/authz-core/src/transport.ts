/**
 * The port through which this library asks a decision point what a subject may do,
 * and the shapes that cross it.
 *
 * Nothing in this file speaks HTTP. There is no URL, no header, no client. The port is
 * an interface the consumer implements; how the answers arrive is the consumer's
 * problem and changing it must not touch this package.
 */

import type { Decision, PermissionEntry } from "./decision.js";

/**
 * One authorization context the subject may work under.
 *
 * A subject may hold several: the same person can act under more than one arrangement,
 * and each one carries its own permissions. Which one is active is a choice, not a
 * property of the person.
 */
export interface AuthorizationContext {
  /**
   * Opaque identifier of the context.
   *
   * **This library never interprets it.** It is not parsed, not split, not compared for
   * meaning, not sorted by and not logged. It is passed back to the transport exactly as
   * it arrived. A client that could read structure out of this string would start making
   * decisions from it, and those decisions would be unenforceable.
   */
  readonly contextId: string;
  /** Human-readable name, for a picker. Display only; never used to decide. */
  readonly label: string;
  /** Whether this context grants entry to the application being asked about. */
  readonly hasAccess: boolean;
}

/**
 * A request for instance-level decisions: the cross product of `actions` and
 * `resourceIds` over one resource type.
 */
export interface DecisionRequest {
  readonly resourceType: string;
  readonly actions: readonly string[];
  readonly resourceIds: readonly string[];
}

/** The type-level answer: what the subject may attempt at all, in one app and context. */
export interface PermissionMenu {
  /**
   * The `app` this answer is about. **Your transport must echo the value it was called
   * with.** An answer whose `app` does not match is discarded — silently and fail-closed.
   */
  readonly app: string;
  /**
   * The context this answer is about. **Your transport must echo the value it was called
   * with.** An answer whose `contextId` does not match is discarded — silently and
   * fail-closed.
   */
  readonly contextId: string;
  readonly permissions: readonly PermissionEntry[];
  /** When the decision point computed this menu. Diagnostic; never used to decide. */
  readonly computedAt?: string;
}

/** The instance-level answer to one {@link DecisionRequest}. */
export interface DecisionSet {
  /**
   * The `app` this answer is about. **Your transport must echo the value it was called
   * with.** An answer whose `app` does not match is discarded — silently and fail-closed.
   */
  readonly app: string;
  /**
   * The context this answer is about. **Your transport must echo the value it was called
   * with.** An answer whose `contextId` does not match is discarded — silently and
   * fail-closed.
   */
  readonly contextId: string;
  readonly decisions: readonly Decision[];
}

/**
 * The only distinction this library draws between failures.
 *
 * `NO_ACCESS_IN_APP` is an answer: the decision point was reached and said no. `UNAVAILABLE`
 * is the absence of an answer — unreachable, timed out, malformed. They are kept apart
 * because they lead the consumer to two different screens, and collapsing them turns an
 * outage into "you are not authorized".
 */
export type TransportErrorKind = "NO_ACCESS_IN_APP" | "UNAVAILABLE";

/**
 * The error a transport rejects with.
 *
 * **`kind` is the only member this library reads.** Everything else — the message, the
 * stack, whatever a transport attaches — is diagnostic and never reaches a decision.
 */
export class AuthorizationTransportError extends Error {
  readonly kind: TransportErrorKind;

  constructor(kind: TransportErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "AuthorizationTransportError";
    this.kind = kind;
  }
}

/**
 * What a consumer implements so this library can ask questions.
 *
 * **No method takes a subject, a role, a person identifier or a token, and that is the
 * point of the shape.** The implementation obtains the caller's identity however it
 * wants — a cookie, a header it adds itself, a session it already holds. This library
 * never sees it, and therefore can never assert it. A client that could name its own
 * subject could name a different one.
 */
export interface AuthorizationTransport {
  /** The contexts the subject may work under, for this application. */
  listContexts(app: string): Promise<readonly AuthorizationContext[]>;

  /** The type-level menu for one context. */
  fetchPermissions(app: string, contextId: string): Promise<PermissionMenu>;

  /**
   * Instance-level decisions for one chunk of a request.
   *
   * The chunking is done by this library — see `splitDecisionRequest`. An implementation
   * receives requests already within the cap it declared and does not need to split again.
   */
  fetchDecisions(
    app: string,
    contextId: string,
    request: DecisionRequest,
  ): Promise<DecisionSet>;
}
