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
 *
 * **It never throws.** It is read while a screen is being drawn, where a throw takes the render
 * down, so whatever it cannot use — a collection that is not an array, a key that is not a string,
 * a collection or an element that throws while it is searched — reads as absent, and absent is
 * `DENY`.
 *
 * **Every element is read.** A pair listed more than once reads as the most restrictive of the
 * elements that name it, and an element that is a function makes every pair `DENY`.
 */
export function decisionFor(
  decisions: readonly Decision[],
  action: string,
  resourceId: string,
): DecisionEffect {
  // Anything that throws while this looks — a revoked `Proxy`, a `find` that is not the array's, an
  // accessor that throws — makes the whole answer absent, and absent is DENY: this is read while a
  // screen is being drawn, and it never throws. See the rule above `namesPair`.
  try {
    // A collection this cannot search is absent too.
    if (!Array.isArray(decisions)) {
      return "DENY";
    }
    // An element that does not name its pair is absent, like a pair the decision point did not
    // return. Checked on the element and not left to the comparison: an element with no
    // `resourceId` equals a lookup whose `resourceId` is `undefined`, and a `null` element throws
    // when read.
    return mostRestrictiveOf(decisions, (d) => {
      const a = d.action;
      const r = d.resourceId;
      return typeof a === "string" && typeof r === "string" && a === action && r === resourceId;
    });
  } catch {
    return "DENY";
  }
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
  // Same rule: `state.permissions` read off a state that is not READY is `undefined`, and it reads
  // DENY rather than taking the render down; so does anything that throws while this looks.
  try {
    if (!Array.isArray(permissions)) {
      return "DENY";
    }
    return mostRestrictiveOf(permissions, (p) => {
      const a = p.action;
      return typeof a === "string" && a === action;
    });
  } catch {
    return "DENY";
  }
}

/**
 * The effect of every element `matches` accepts, collapsed to the most restrictive, or `DENY` when none
 * does — the rule above `namesPair`, applied to a collection a consumer hands in.
 *
 * **Every element is read, not the first that matches:** a collection can name a pair twice, and the
 * second may be its `DENY`. What `decide()` returns and what `READY` carries never give one pair or
 * one action two different answers, so over those this answers what the first match would. An
 * element that is a function reads `DENY` for every key: it can carry the fields that name any pair,
 * and it is not data.
 *
 * The collection is walked through its own `find`, with a predicate that never matches, so a `find`
 * that throws still reads `DENY` and one that returns an element without asking the predicate answers
 * nothing.
 */
function mostRestrictiveOf(
  collection: readonly unknown[],
  matches: (element: Record<string, unknown>) => boolean,
): DecisionEffect {
  let found: { readonly effect: DecisionEffect } | undefined;
  let unusable = false;
  collection.find((element) => {
    if (typeof element === "function") {
      unusable = true;
      return true;
    }
    // `null` and `undefined` hold nothing. Every other element is read — a string or a number too,
    // through the prototype its kind shares — so what does not match is what its read did not match.
    if (element !== null && element !== undefined && matches(element as Record<string, unknown>)) {
      const read = { effect: effectOf(element as { readonly effect: DecisionEffect }) };
      found = found === undefined ? read : mostRestrictive(found, read);
    }
    return false;
  });
  return unusable || found === undefined ? "DENY" : found.effect;
}

/**
 * Deny-overrides, the same floor the decision engine itself applies: `DENY` beats
 * `CONDITIONAL` beats `PERMIT`.
 *
 * Fail-closed and still functional — a duplicate never widens what the subject may do, and a
 * legitimate one (an engine emitting a row per policy) still resolves to an answer. The same floor
 * serves a decision pair and a menu action. On a tie the first is kept.
 */
export function mostRestrictive<T extends { readonly effect: DecisionEffect }>(a: T, b: T): T {
  // Only PERMIT ranks as permissive. Everything else — the two declared restrictive effects
  // AND anything outside the union that reached us at runtime — ranks above it. The previous
  // form defaulted the unknown to 0, so an effect this function does not understand was as
  // safe as PERMIT and could never restrict one arriving beside it. A collapse function in an
  // authorization package must not resolve "I do not know what this is" permissively.
  const rank = (effect: DecisionEffect): number =>
    effect === "PERMIT" ? 0 : effect === "CONDITIONAL" ? 1 : 2;
  return rank(b.effect) > rank(a.effect) ? b : a;
}

/*
 * THE RULE THESE PREDICATES ENFORCE, written so the next place a value enters can be derived from it
 * instead of copied from the last one.
 *
 * **Every value that reaches this package from outside it — an argument a consumer passes, or an
 * answer a backend returns — is checked where it enters, against the shape the published type
 * declares. A value of the wrong shape is REFUSED if the consumer supplied it, and NOT USED if a
 * backend did.**
 *
 * The treatments differ because the sides do. A consumer's wrong shape is a programming error in code
 * the consumer controls, so refusing it loudly shows it on the first call, in development. A
 * backend's wrong shape arrives in production, from code this package does not control, while a
 * subject waits for a screen: it is not used, and what is left absent reads `DENY`. How much is left
 * absent with it is the next rule.
 *
 * **Discarding — dropping one element and keeping the ones beside it — is safe only where no `PERMIT`
 * can answer for that element's pair: for an element that is proven to name no pair that was asked,
 * and for one whose pair is left absent. An element that cannot be read may be the `DENY` of any
 * pair, so it is not discarded: a menu that carries one is unavailable, and an answer that carries one
 * leaves every pair of that call absent, with nothing cached.** A discarded `DENY` is not an absent
 * one: the `PERMIT` beside it for the same pair then answers alone.
 *
 * **Absent is absent wherever this package answers from.** A session answers a pair from what a call
 * returns and, afterwards, from its decision cache, which holds for each pair what the last call that
 * asked for it returned; a pair a call leaves absent is absent from the cache too. That is what makes
 * it safe to drop an element that another chunk sent for a pair the chunk that asked for it did not
 * answer: what another chunk says about a pair can make it more restrictive and cannot answer it, so
 * the pair is left absent — in what the call returns, and in the cache. Kept in the cache instead, an
 * earlier `PERMIT` answered beside a `DENY` the call had received and dropped.
 *
 * **What is proven is what an ordinary read gave. A description of a field is not the field.** A field
 * is what `element.action` gives — through an accessor, a `Proxy`'s `get`, or the prototype, wherever
 * that read goes — and not what the element's descriptors, its type, its keys or its class say about
 * it: each of those can say one thing while the read gives another, and the read is what the element
 * answers. So a mark of "proven to name no pair" stands on an operation that can be pointed at in the
 * code, and on nothing else: an ordinary read of the fields that name a pair and a comparison of what
 * it gave with the string keys; a read that gave `null` or `undefined` where a list would be; the
 * length an ordinary read of a list gives, below which its positions are; or the check that a value is
 * `null` or `undefined`, which hold no field and have no prototype. Whatever this
 * package did not read is not proven, however it looks.
 *
 * An element names a pair through the fields its type declares for that — a decision's `action` and
 * `resourceId`, a menu entry's `action` — compared as strings, as they are. So what is proven to name
 * no pair: `null` and `undefined`; any other value but a function whose identifying fields, read, are
 * not all strings — an object, and a string, a number or a boolean too, whose fields are read through
 * the prototype its kind shares; a pair nobody asked for, whose key, built from what was read, equals no key that was
 * asked; every element of an answer whose `app`, read, is not this application, since an answer's
 * pairs are that label's pairs; and an answer whose `decisions`, read, is `null` or `undefined`, which
 * holds no element. What is NOT proven, and so is never discarded: an element whose read throws; a
 * function, which can carry every declared field and is not data; an answer whose envelope throws when
 * read, or is a function, or whose `decisions` is present, not `null` or `undefined`, and is not an
 * array — a `Set`, a `Map`'s values, an array-like — which is not read as a list; and a position a list
 * gained while it was being read. Each of those makes the whole answer unusable instead. And a lookup
 * reads every element, not the first one that names the pair: the one after it may be that pair's
 * `DENY`.
 *
 * **What this package takes as it is given, named here so that nobody reads it as checked.** An
 * answer's `app`: its pairs are the pairs of the application it names, as the port declares, and
 * nothing else in it is read to confirm that. The length an ordinary read of a list gives: the
 * positions below it are the list, so a list that claims fewer positions than it holds is read to the
 * length it claims. The `find` of a collection a consumer hands to `decisionFor` or `permissionFor`: the
 * collection is walked through it, so an element that `find` does not visit is not read. And the order
 * in which two calls in flight at once are answered: of two that ask for one pair, the decision cache
 * holds what the one answered last returned, whichever was made first and whatever the other said.
 *
 * **What is used is what was checked.** A value that arrives from outside is read ONCE, where it is
 * checked, and every later use is that copy — never the outside object read a second time. Whoever
 * handed it over can still reach it: a consumer can change a request object while its answers are in
 * flight, a transport can rewrite an answer it already returned, and a caller can write into the
 * decisions it was given. Read again after a suspension point, such a value is one this package never
 * checked, and the worst of it is concrete: one resource type's answers filed under another type's
 * cache key, then served from the cache as a `PERMIT` the backend never gave. The same holds the other
 * way: what this package hands to a transport is the transport's to reach, so it hands over copies and
 * keeps what it reads. So `decide()` checks a copy of the request and uses nothing else, and hands
 * each chunk's request to the transport as a copy of its own; the envelope of each answer is read
 * once, with its list
 * (whose length is asked once more, afterwards, only to tell whether it grew while it was read);
 * each element of an answer, and each menu entry, is copied where it is checked; and the decision
 * cache never holds an object it has handed out.
 *
 * **Where a refusal is delivered.** Where failing is already part of the call's contract: at
 * construction, or as the rejection of a promise the caller holds. A function whose answer is read
 * synchronously while a screen is being drawn — `decisionFor`, `permissionFor`, `isRenderable` —
 * never throws: an argument it cannot use reads as absent, and absent is `DENY`. That is what makes
 * those three total, and it is why the rule's refusal reaches them as `DENY` rather than as an
 * exception: a throw inside a render takes the screen down, while the rejection of `decide()` is
 * something a component already awaits.
 *
 * **An identifier is a string** — an application id, a resource type, an action, a resource id. Not a
 * number, not a boxed string, not anything else. The published types already say `string`; accepting
 * something wider at runtime would make the contract wider than the type that publishes it, which is
 * a lie in the direction that matters. Most identifiers are UUIDs in practice, so this is the shape
 * they already have rather than a restriction. **Nothing is coerced.** This package carries and
 * compares identifiers and never interprets one, and coercing is interpreting: `String(null)` is
 * `"null"` and `String({})` is `"[object Object]"`, so a coerced bug stops failing and becomes a valid
 * identifier that can collide with a real one — and the backend it is sent to was never told.
 *
 * Where it is applied: the two backend answers — the menu and each decision answer — are checked as
 * an envelope and then entry by entry, with the predicates below: what names no pair is discarded,
 * and what cannot be read leaves the answer unused;
 * the request `decide()` sends is refused with a `RangeError` before the cache is read or the
 * transport is called — the class every deliberate refusal of a caller's mistake in these packages
 * uses, so a consumer catches one class for one kind of mistake.
 *
 * **Finished, and total on purpose:** the lookup keys and the collections of `decisionFor` and
 * `permissionFor`. By the clause on where a refusal is delivered, whatever they cannot use reads as
 * absent, so they will never refuse anything — and a `DENY` there is the rule applied, not a check
 * still to come.
 *
 * Consumer arguments the rule covers and that are not checked where they enter: the `app` and
 * `transport` a session is created with, `maxPairsPerRequest` until the first `decide()`, a request
 * passed straight to `splitDecisionRequest`, and the listener passed to `subscribe`. This package
 * refuses none of them there yet. A refusal of any of them belongs at construction or at the call that
 * receives it — never inside a lookup.
 */

/**
 * Whether an element names the pair it answers: an object whose `action` and `resourceId` are both
 * strings, which is what {@link Decision} declares.
 *
 * **Strings, and not non-empty strings.** An empty id is the consumer's to ask about: it passes
 * the requested-pair check only when the request carried it, and refusing it there would hide an
 * answer the decision point gave to a question the consumer asked. Extra fields change nothing.
 */
export function namesPair(element: unknown): boolean {
  return (
    isRecord(element) &&
    typeof element.action === "string" &&
    typeof element.resourceId === "string"
  );
}

/** Whether a menu entry names its action. Same rule as {@link namesPair}, one dimension less. */
export function namesAction(entry: unknown): boolean {
  return isRecord(entry) && typeof entry.action === "string";
}

/** An object, which a field can be read from without throwing. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The effect of an element that was found, or `DENY`.
 *
 * An element that names its pair but carries no string `effect` answers nothing readable. It is
 * not discarded: the collapse in the session already ranks it above `PERMIT` and `CONDITIONAL`,
 * and dropping it would let a `PERMIT` for the same pair win. Read here, it is `DENY`. A string
 * outside the union is returned as it is, and does not render.
 */
function effectOf(found: { readonly effect: DecisionEffect } | undefined): DecisionEffect {
  const effect = found?.effect;
  return typeof effect === "string" ? effect : "DENY";
}
