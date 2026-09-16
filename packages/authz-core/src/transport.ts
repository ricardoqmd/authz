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
 * A request for instance-level decisions: the cross product of `actions` and
 * `resourceIds` over one resource type.
 */
export interface DecisionRequest {
  readonly resourceType: string;
  readonly actions: readonly string[];
  readonly resourceIds: readonly string[];
}

/** The type-level answer: what the subject may attempt at all, in one application. */
export interface PermissionMenu {
  /**
   * The `app` this answer is about. **Your transport must echo the value it was called
   * with.** An answer whose `app` does not match is discarded — silently and fail-closed.
   */
  readonly app: string;
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
   * An array. An answer whose `decisions` is present — not `null`, not `undefined` — and is not an
   * array leaves every pair of the call `DENY`, the pairs the other chunks of the call answered too.
   * One with `null` there, or with no `decisions` at all, holds no element, and leaves absent only the
   * pairs of its own request.
   */
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
  /** The type-level menu: what the subject may attempt at all, in this application. */
  fetchPermissions(app: string): Promise<PermissionMenu>;

  /**
   * Instance-level decisions for one chunk of a request.
   *
   * The chunking is done by this library — see `splitDecisionRequest`. An implementation
   * receives requests already within the cap it declared and does not need to split again.
   *
   * **Each answer carries the pairs its own request asked for.** A pair is answered only by the
   * answer to a request that asked for it; what another call's answer says about that pair can make
   * it more restrictive, and cannot answer it. So an implementation that groups concurrent calls
   * into one has to hand each call the decisions for the pairs in the `request` that call was given:
   * delivering the combined answer to one call and an empty one to the rest leaves the pairs of the
   * rest absent, and absent is `DENY`.
   *
   * **An answer whose `decisions` is present — not `null`, not `undefined` — and is not an array
   * leaves every pair of the call `DENY`** — the pairs the other chunks of the call answered too. A
   * page of results (`{ items, next }`), a map serialised as an object, `{}`, a string, a number, a
   * boolean, a `Set`: none of them is read as a list, and none is taken for an empty one; the package
   * does not look inside a value that is not an array. It happens silently and on every call: the call
   * resolves, nothing rejects, the session stays `READY`, and since nothing of that call is cached the
   * next one asks again and gets the same. Return what your server sent, parsed, only once you have
   * checked that its `decisions` is an array, and reject otherwise: a rejection leaves absent only the
   * pairs of the request it answers. An answer with no `decisions` at all, or `null` there, holds no
   * element, and it too leaves absent only the pairs of its own request.
   */
  fetchDecisions(app: string, request: DecisionRequest): Promise<DecisionSet>;
}
