/**
 * The port through which this package asks which authorization contexts a subject holds, and the
 * shape those contexts have.
 *
 * Nothing here speaks HTTP. There is no URL, no header, no client — the port is an interface the
 * consumer implements, and how the answer arrives is the consumer's problem.
 */

/**
 * One authorization context the subject may work under.
 *
 * A subject may hold several: the same person can act under more than one arrangement, and each one
 * carries its own permissions. Which one is active is a choice, not a property of the person.
 */
export interface AuthorizationContext {
  /**
   * Opaque identifier of the context.
   *
   * **This library never interprets it.** It is not parsed, not split, not compared for meaning,
   * not sorted by and not logged. It is passed back to the consumer exactly as it arrived. A client
   * that could read structure out of this string would start making decisions from it, and those
   * decisions would be unenforceable.
   */
  readonly contextId: string;
  /** Human-readable name, for a picker. Display only; never used to decide. */
  readonly label: string;
  /** Whether this context grants entry to the application being asked about. */
  readonly hasAccess: boolean;
}

/**
 * What a consumer implements so this package can list contexts.
 *
 * **No method takes a subject, a role, a person identifier or a token**, and that is the point of
 * the shape: the implementation obtains the caller's identity however it wants, this package never
 * sees it, and therefore can never assert it.
 */
export interface ContextTransport {
  /** The contexts the subject may work under, for this application. */
  listContexts(app: string): Promise<readonly AuthorizationContext[]>;
}
