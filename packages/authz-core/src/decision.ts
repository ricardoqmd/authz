/**
 * The vocabulary of a decision, and the two rules that must never be decided
 * by a consumer: what a given effect renders as, and what an absent answer means.
 *
 * Nothing here accepts a subject, a role or a person identifier. The enforcement
 * point derives the subject from the validated token; a client that could assert
 * its own identity would make every decision below meaningless.
 */

/**
 * The three-valued outcome of an authorization decision.
 *
 * `CONDITIONAL` is not an error and not a soft deny: it means the decision depends
 * on information that was not available when it was computed.
 */
export type DecisionEffect = "PERMIT" | "DENY" | "CONDITIONAL";

/** A type-level entry: one action the subject may attempt in an application. */
export interface PermissionEntry {
  /** Opaque action identifier, as published by the decision point. */
  readonly action: string;
  readonly effect: DecisionEffect;
  /**
   * When the effect is `CONDITIONAL`, the attributes the decision depends on.
   * Advisory: useful for diagnostics, never for deciding in the client.
   */
  readonly dependsOn?: readonly string[];
}

/** An instance-level answer: one action against one resource. */
export interface Decision {
  readonly action: string;
  readonly resourceId: string;
  readonly effect: DecisionEffect;
}

/**
 * Whether an effect should be rendered.
 *
 * `CONDITIONAL` renders. Hiding an action because the answer is "it depends" turns
 * *depends* into *no*, which is what pushes people to ask for an administrator role
 * for everything. The action is shown; if the enforcement point later denies it, the
 * user gets a message — and a message is information, while an invisible button is not.
 */
export function isRenderable(effect: DecisionEffect): boolean {
  return effect === "PERMIT" || effect === "CONDITIONAL";
}

/**
 * The effect for one action over one resource, defaulting to `DENY`.
 *
 * Absence is the common case that has to be safe: a truncated response, a batch chunk
 * that failed, a pair the decision point did not return. All of them mean *deny*, and
 * none of them may be reported as an error the caller could accidentally treat as a
 * permit.
 */
export function decisionFor(
  decisions: readonly Decision[],
  action: string,
  resourceId: string,
): DecisionEffect {
  const found = decisions.find(
    (d) => d.action === action && d.resourceId === resourceId,
  );
  return found ? found.effect : "DENY";
}

/**
 * The type-level effect for one action, defaulting to `DENY`.
 *
 * Same rule as {@link decisionFor}, one dimension less.
 */
export function permissionFor(
  permissions: readonly PermissionEntry[],
  action: string,
): DecisionEffect {
  const found = permissions.find((p) => p.action === action);
  return found ? found.effect : "DENY";
}
