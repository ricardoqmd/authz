import { describe, expect, it } from "vitest";

import { decisionFor, permissionFor, type Decision, type DecisionEffect } from "./decision.js";
import { createAuthorizationSession } from "./session.js";
import {
  AuthorizationTransportError,
  type AuthorizationTransport,
  type DecisionRequest,
  type DecisionSet,
  type PermissionMenu,
} from "./transport.js";

/**
 * A session answers a pair from three places — the array a call returns, the decision cache, and the
 * `READY` state — and each has a rule of one line:
 *
 *   - a call that asks the transport returns, for each pair it asked, the most restrictive of what the
 *     chunks that asked for that pair said, made more restrictive by what its other chunks said about
 *     it; nothing for a pair no chunk that asked for it answered; and nothing at all when an answer
 *     could not be read;
 *   - the cache holds, for each pair, what the last call answered that asked for it returned, and
 *     nothing when that call left the pair absent; `start()` and `close()` empty it;
 *   - `READY` holds what the last `start()` read, and nothing an earlier one read.
 *
 * This file keeps its own account of the three, step by step, and holds the session to it over many
 * sequences of calls drawn from fixed seeds. The sequences mix calls whose chunks answer in every way
 * the rules speak of — every pair, some of them, pairs nobody asked for, pairs another chunk asked
 * for, a pair twice, another application's label, a rejection, no list, a list that is not an array,
 * an element that cannot be read, a transport that edits the request it is handed — with changes to
 * what the backend answers between calls, calls answered from the cache in whole or in part, two
 * calls in flight at once answered in either order, a `start()` landing while a call is in flight, and
 * `close()`. A failure names the seed and the step, so a sequence can be run again alone.
 *
 * What these sequences do not reach, so that a pass is not read as more than it is: eviction by
 * `maxCachedDecisions` (they never hold that many pairs); a list that grows while it is read, or any
 * value whose reads change from one read to the next; a caller or a transport that changes an object
 * after handing it over, other than the request a transport is handed; a transport that throws
 * before it returns a promise; an effect outside `PERMIT`, `CONDITIONAL` and `DENY`, and a menu
 * entry's `dependsOn`; more than two calls in flight at once, and a `start()` or `close()` landing
 * while two are; how a request is split, beyond each chunk staying within the cap and the chunks
 * together asking exactly the request's pairs; a request the session refuses; `subscribe`; and
 * `@ricardoqmd/authz-context`. Those are held elsewhere, one case at a time.
 */

const APP = "app-a";
const TYPES = ["orders", "invoices"] as const;
const ACTIONS = ["read", "edit", "approve"] as const;
const IDS = ["r-1", "r-2", "r-3", "r-4", "r-5"] as const;
/** Added to a request by a transport that edits what it is handed; never asked for. */
const ADDED_ID = "r-9";
const EFFECTS: readonly DecisionEffect[] = ["PERMIT", "CONDITIONAL", "DENY"];
const CAPS = [1, 2, 3, 4, 100] as const;
const SEQUENCES = 400;
const STEPS = 16;

type Effect = DecisionEffect;

const rank = (effect: Effect): number => (effect === "PERMIT" ? 0 : effect === "CONDITIONAL" ? 1 : 2);
const stricter = (a: Effect, b: Effect): Effect => (rank(b) > rank(a) ? b : a);
const pairOf = (action: string, resourceId: string): string => `${action} ${resourceId}`;
const keyOf = (resourceType: string, action: string, resourceId: string): string =>
  `${resourceType} ${action} ${resourceId}`;

/** The same numbers for the same seed, on every machine. */
function numbers(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const below = (count: number): number => Math.floor(next() * count);
  const chance = (p: number): boolean => next() < p;
  const pick = <T>(items: readonly T[]): T => items[below(items.length)] as T;
  const weighted = <T>(items: readonly (readonly [number, T])[]): T => {
    let left = next() * items.reduce((sum, [weight]) => sum + weight, 0);
    for (const [weight, item] of items) {
      left -= weight;
      if (left < 0) {
        return item;
      }
    }
    return (items[items.length - 1] as readonly [number, T])[1];
  };
  /** Between `min` and `max` of `items`, in a drawn order, now and then with one of them twice. */
  const some = <T>(items: readonly T[], min: number, max: number): T[] => {
    const pool = [...items];
    const out: T[] = [];
    const count = min + below(max - min + 1);
    while (out.length < count && pool.length > 0) {
      out.push(pool.splice(below(pool.length), 1)[0] as T);
    }
    if (out.length > 0 && chance(0.08)) {
      out.push(pick(out));
    }
    return out;
  };
  return { below, chance, pick, weighted, some };
}
type Numbers = ReturnType<typeof numbers>;

/* — what a chunk says ------------------------------------------------------------------------- */

/** One element of an answer, as the rules read it. */
type Element =
  | { readonly names: "pair"; readonly action: string; readonly resourceId: string; readonly effect: Effect | undefined }
  | { readonly names: "nothing" | "unreadable"; readonly value: unknown };

/** What one chunk said, as the rules read it. */
type Said =
  | { readonly outcome: "rejects" | "no list" | "not a list" }
  | { readonly outcome: "answers"; readonly label: string; readonly elements: readonly Element[] };

const BEHAVIOURS = [
  [10, "every pair"],
  [2, "some pairs"],
  [1, "pairs nobody asked for"],
  [2, "pairs other chunks asked for"],
  [1, "a pair twice"],
  [1, "another label"],
  [1, "rejects"],
  [1, "no list"],
  [1, "not a list"],
  [1, "an element that cannot be read"],
  [1, "elements that name no pair"],
  [1, "an element with no effect"],
  [1, "edits the request before answering"],
  [1, "edits the request after answering"],
] as const;
type Behaviour = (typeof BEHAVIOURS)[number][1];

function pair(action: string, resourceId: string, effect: Effect | undefined): Element {
  return { names: "pair", action, resourceId, effect };
}

function rendered(element: Element): unknown {
  if (element.names !== "pair") {
    return element.value;
  }
  return element.effect === undefined
    ? { action: element.action, resourceId: element.resourceId }
    : { action: element.action, resourceId: element.resourceId, effect: element.effect };
}

function unreadable(n: Numbers, action: string, resourceId: string): Element {
  const value = n.chance(0.5)
    ? Object.defineProperty({ resourceId, effect: "DENY" }, "action", {
        get() {
          throw new Error("unreadable");
        },
        enumerable: true,
      })
    : Object.assign(() => undefined, { action, resourceId, effect: "DENY" });
  return { names: "unreadable", value };
}

/** What a transport that behaves as `behaviour` says for the request it was handed, and the value it resolves to. */
function answerFor(
  n: Numbers,
  behaviour: Behaviour,
  request: DecisionRequest,
  truth: (resourceType: string, action: string, resourceId: string) => Effect,
): { said: Said; value: unknown } {
  if (behaviour === "edits the request before answering") {
    (request.resourceIds as string[]).push(ADDED_ID);
  }
  const own: Element[] = request.actions.flatMap((action) =>
    request.resourceIds.map((resourceId) => pair(action, resourceId, truth(request.resourceType, action, resourceId))),
  );
  let elements: Element[] = own;
  let label = APP;
  switch (behaviour) {
    case "rejects":
      return { said: { outcome: "rejects" }, value: undefined };
    case "no list":
      return { said: { outcome: "no list" }, value: n.pick([null, undefined, { app: APP }, { app: APP, decisions: null }]) };
    case "not a list": {
      const list = own.map(rendered);
      return {
        said: { outcome: "not a list" },
        value: n.pick([
          { app: APP, decisions: {} },
          { app: APP, decisions: new Set(list) },
          { app: APP, decisions: { items: list, next: null } },
          { app: APP, decisions: "unavailable" },
          Object.assign(() => undefined, { app: APP, decisions: list }),
        ]),
      };
    }
    case "some pairs":
      elements = own.filter(() => n.chance(0.5));
      break;
    case "pairs nobody asked for":
      elements = [...own, pair(n.pick(ACTIONS), n.pick(["r-7", "r-8"]), "PERMIT")];
      break;
    case "pairs other chunks asked for":
      elements = [...own, ...Array.from({ length: 1 + n.below(3) }, () => pair(n.pick(ACTIONS), n.pick(IDS), n.pick(EFFECTS)))];
      break;
    case "a pair twice":
      if (own.length > 0) {
        const twice = n.pick(own);
        elements = [...own, { ...twice, effect: n.pick(EFFECTS) } as Element];
      }
      break;
    case "another label":
      label = n.pick(["app-b", "App-A"]);
      elements = own.map((element) => ({ ...element, effect: "PERMIT" }) as Element);
      break;
    case "an element that cannot be read": {
      const at = n.below(own.length + 1);
      elements = [...own.slice(0, at), unreadable(n, n.pick(ACTIONS), n.pick(IDS)), ...own.slice(at)];
      break;
    }
    case "elements that name no pair":
      elements = [
        ...own,
        { names: "nothing", value: n.pick([null, undefined, "PERMIT", 0]) },
        { names: "nothing", value: { action: n.pick(ACTIONS), resourceId: 7, effect: "PERMIT" } },
      ];
      break;
    case "an element with no effect":
      if (own.length > 0) {
        const at = n.below(own.length);
        elements = own.map((element, index) => (index === at ? ({ ...element, effect: undefined } as Element) : element));
      }
      break;
    default:
      break;
  }
  if (n.chance(0.3)) {
    elements = [...elements].reverse();
  }
  const value = { app: label, decisions: elements.map(rendered) };
  if (behaviour === "edits the request after answering") {
    (request.actions as string[]).length = 0;
    (request.resourceIds as string[]).length = 0;
  }
  return { said: { outcome: "answers", label, elements }, value };
}

/* — what a menu says ------------------------------------------------------------------------- */

interface MenuPlan {
  readonly kind: string;
  readonly status: "READY" | "UNAVAILABLE" | "NO_ACCESS_IN_APP";
  readonly entries: ReadonlyMap<string, Effect>;
  readonly answer: () => PermissionMenu;
}

function drawMenu(n: Numbers): MenuPlan {
  const unusable = (kind: string, status: MenuPlan["status"], answer: () => unknown): MenuPlan => ({
    kind,
    status,
    entries: new Map(),
    answer: answer as () => PermissionMenu,
  });
  const kind = n.weighted([
    [8, "entries"],
    [1, "no entries"],
    [1, "rejects, no access"],
    [1, "rejects, unavailable"],
    [1, "rejects with a plain error"],
    [1, "another label"],
    [1, "no answer"],
    [1, "not a list"],
    [1, "an entry that cannot be read"],
    [1, "only entries that name no action"],
  ] as const);
  switch (kind) {
    case "no entries":
      return { kind, status: "READY", entries: new Map(), answer: () => ({ app: APP, permissions: [] }) };
    case "rejects, no access":
      return unusable(kind, "NO_ACCESS_IN_APP", () => {
        throw new AuthorizationTransportError("NO_ACCESS_IN_APP");
      });
    case "rejects, unavailable":
      return unusable(kind, "UNAVAILABLE", () => {
        throw new AuthorizationTransportError("UNAVAILABLE");
      });
    case "rejects with a plain error":
      return unusable(kind, "UNAVAILABLE", () => {
        throw new Error("down");
      });
    case "another label":
      return unusable(kind, "UNAVAILABLE", () => ({ app: "app-b", permissions: [{ action: "read", effect: "PERMIT" }] }));
    case "no answer":
      return unusable(kind, "UNAVAILABLE", () => n.pick([null, { app: APP }, { app: APP, permissions: null }]));
    case "not a list":
      return unusable(kind, "UNAVAILABLE", () => ({ app: APP, permissions: { read: { action: "read", effect: "PERMIT" } } }));
    case "an entry that cannot be read":
      return unusable(kind, "UNAVAILABLE", () => ({
        app: APP,
        permissions: [
          { action: "read", effect: "PERMIT" },
          Object.defineProperty({ effect: "DENY" }, "action", {
            get() {
              throw new Error("unreadable");
            },
            enumerable: true,
          }),
        ],
      }));
    case "only entries that name no action":
      return unusable(kind, "UNAVAILABLE", () => ({ app: APP, permissions: [null, { action: 7, effect: "PERMIT" }] }));
    default: {
      const listed = n.some([...ACTIONS, "export"], 1, 4).map((action) => ({
        action,
        effect: n.chance(0.1) ? undefined : n.pick(EFFECTS),
      }));
      const entries = new Map<string, Effect>();
      for (const { action, effect } of listed) {
        const read = effect ?? "DENY";
        const seen = entries.get(action);
        entries.set(action, seen === undefined ? read : stricter(seen, read));
      }
      const nameless = n.chance(0.2) ? [null, { action: 7, effect: "PERMIT" }] : [];
      const permissions = [
        ...listed.map(({ action, effect }) => (effect === undefined ? { action } : { action, effect })),
        ...nameless,
      ];
      return { kind: "entries", status: "READY", entries, answer: () => ({ app: APP, permissions }) as unknown as PermissionMenu };
    }
  }
}

/* — the account this file keeps -------------------------------------------------------------- */

interface Chunk {
  readonly asked: { readonly resourceType: string; readonly actions: readonly string[]; readonly resourceIds: readonly string[] };
  readonly said: Said;
  release?: () => void;
}

type Answered = Map<string, { readonly action: string; readonly resourceId: string; readonly effect: Effect }>;

interface Expected {
  status: "IDLE" | "READY" | "UNAVAILABLE" | "NO_ACCESS_IN_APP";
  menu: ReadonlyMap<string, Effect>;
  readonly cache: Map<string, Effect>;
  closed: boolean;
}

interface Tally {
  readonly behaviours: Map<string, number>;
  readonly menus: Map<string, number>;
  readonly steps: Map<string, number>;
  readonly counts: Map<string, number>;
}

const count = (into: Map<string, number>, key: string): void => {
  into.set(key, (into.get(key) ?? 0) + 1);
};

function distinctPairs(request: DecisionRequest): Map<string, { readonly action: string; readonly resourceId: string }> {
  const out = new Map<string, { readonly action: string; readonly resourceId: string }>();
  for (const action of request.actions) {
    for (const resourceId of request.resourceIds) {
      out.set(pairOf(action, resourceId), { action, resourceId });
    }
  }
  return out;
}

/** What the cache answers for `request` as a whole, or `undefined` when it does not hold every pair. */
function fromCache(cache: ReadonlyMap<string, Effect>, request: DecisionRequest): Answered | undefined {
  const wanted = distinctPairs(request);
  if (wanted.size === 0) {
    return undefined;
  }
  const out: Answered = new Map();
  for (const [key, { action, resourceId }] of wanted) {
    const hit = cache.get(keyOf(request.resourceType, action, resourceId));
    if (hit === undefined) {
      return undefined;
    }
    out.set(key, { action, resourceId, effect: hit });
  }
  return out;
}

const cannotBeRead = (said: Said): boolean =>
  said.outcome === "not a list" ||
  (said.outcome === "answers" && said.label === APP && said.elements.some((element) => element.names === "unreadable"));

/** What a call that asked the transport returns, pair by pair, from what its chunks said. */
function fromChunks(request: DecisionRequest, chunks: readonly Chunk[], tally: Tally): Answered {
  const answered: Answered = new Map();
  if (chunks.some((chunk) => cannotBeRead(chunk.said))) {
    count(tally.counts, "a call left empty by an answer that could not be read");
    return answered;
  }
  for (const [key, { action, resourceId }] of distinctPairs(request)) {
    let fromAskers: Effect | undefined;
    let fromOthers: Effect | undefined;
    for (const chunk of chunks) {
      if (chunk.said.outcome !== "answers" || chunk.said.label !== APP) {
        continue;
      }
      const asked = chunk.asked.actions.includes(action) && chunk.asked.resourceIds.includes(resourceId);
      for (const element of chunk.said.elements) {
        if (element.names !== "pair" || element.action !== action || element.resourceId !== resourceId) {
          continue;
        }
        const read = element.effect ?? "DENY";
        if (asked) {
          fromAskers = fromAskers === undefined ? read : stricter(fromAskers, read);
        } else {
          fromOthers = fromOthers === undefined ? read : stricter(fromOthers, read);
        }
      }
    }
    if (fromAskers === undefined) {
      continue;
    }
    const effect = fromOthers === undefined ? fromAskers : stricter(fromAskers, fromOthers);
    if (effect !== fromAskers) {
      count(tally.counts, "a pair made more restrictive by a chunk that did not ask for it");
    }
    answered.set(key, { action, resourceId, effect });
  }
  return answered;
}

/** The cache after a call that asked the transport returned `answered`. */
function settle(cache: Map<string, Effect>, request: DecisionRequest, answered: Answered, tally: Tally): void {
  for (const [key, { action, resourceId }] of distinctPairs(request)) {
    const cacheKey = keyOf(request.resourceType, action, resourceId);
    const found = answered.get(key);
    if (found === undefined) {
      if (cache.delete(cacheKey)) {
        count(tally.counts, "a cached pair left absent by a later call");
      }
    } else {
      cache.set(cacheKey, found.effect);
    }
  }
}

/** The first way `returned` differs from `expected`, for the pairs `request` asked. */
function differs(request: DecisionRequest, returned: readonly Decision[], expected: Answered): string | undefined {
  const wanted = distinctPairs(request);
  const seen = new Map<string, unknown>();
  for (const decision of returned) {
    const key = pairOf(decision.action, decision.resourceId);
    if (!wanted.has(key)) {
      return `returned ${key}, which it did not ask for`;
    }
    if (seen.has(key) && seen.get(key) !== decision.effect) {
      return `returned ${key} twice, as ${String(seen.get(key))} and ${String(decision.effect)}`;
    }
    seen.set(key, decision.effect);
  }
  for (const [key, { action, resourceId }] of wanted) {
    const got = decisionFor(returned, action, resourceId);
    const want = expected.get(key)?.effect ?? "DENY";
    if (got !== want) {
      return `${key} answered ${got}, expected ${want}`;
    }
  }
  return undefined;
}

/** The first way the requests handed to the transport are not the chunks of `request`. */
function handedWrong(request: DecisionRequest, chunks: readonly Chunk[], cap: number): string | undefined {
  const wanted = distinctPairs(request);
  if (chunks.length === 0 && wanted.size > 0) {
    return "the transport was not asked, so the cache answered pairs the last call that asked for them left absent";
  }
  const asked = new Set<string>();
  for (const { asked: chunk } of chunks) {
    if (chunk.resourceType !== request.resourceType) {
      return `a chunk was asked about ${chunk.resourceType}`;
    }
    if (chunk.actions.length * chunk.resourceIds.length > cap) {
      return `a chunk asked ${chunk.actions.length * chunk.resourceIds.length} pairs under a cap of ${cap}`;
    }
    for (const action of chunk.actions) {
      for (const resourceId of chunk.resourceIds) {
        asked.add(pairOf(action, resourceId));
      }
    }
  }
  const missing = [...wanted.keys()].filter((key) => !asked.has(key));
  const extra = [...asked].filter((key) => !wanted.has(key));
  return missing.length > 0 || extra.length > 0
    ? `the chunks handed over left out [${missing.join(", ")}] and added [${extra.join(", ")}]`
    : undefined;
}

const describeRequest = (request: DecisionRequest): string =>
  `${request.resourceType} [${request.actions.join(" ")}] x [${request.resourceIds.join(" ")}]`;

/** How a call settled, so that a rejection is a difference the sequence names, and not an escape. */
async function outcome<T>(promise: Promise<T>): Promise<{ readonly value: T } | { readonly rejected: string }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { rejected: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/* — one sequence ----------------------------------------------------------------------------- */

async function sequence(seed: number, tally: Tally): Promise<string | undefined> {
  const n = numbers(seed);
  const cap = n.pick(CAPS);
  const backend = new Map<string, Effect>();
  for (const resourceType of TYPES) {
    for (const action of ACTIONS) {
      for (const resourceId of [...IDS, ADDED_ID]) {
        backend.set(
          keyOf(resourceType, action, resourceId),
          resourceId === ADDED_ID ? "PERMIT" : n.weighted([[6, "PERMIT"], [2, "CONDITIONAL"], [3, "DENY"]] as const),
        );
      }
    }
  }
  const truth = (resourceType: string, action: string, resourceId: string): Effect =>
    backend.get(keyOf(resourceType, action, resourceId)) ?? "PERMIT";

  const calls: Chunk[] = [];
  let menus = 0;
  let hold = false;
  let force: Behaviour | undefined;
  let onFetch: (() => void) | undefined;
  let menu: MenuPlan | undefined;

  const transport: AuthorizationTransport = {
    fetchPermissions: async () => {
      menus += 1;
      if (menu === undefined) {
        throw new Error("no menu was drawn");
      }
      return menu.answer();
    },
    fetchDecisions: async (_app, request) => {
      const asked = { resourceType: request.resourceType, actions: [...request.actions], resourceIds: [...request.resourceIds] };
      const hook = onFetch;
      onFetch = undefined;
      hook?.();
      const behaviour: Behaviour = force ?? n.weighted(BEHAVIOURS);
      count(tally.behaviours, behaviour);
      const { said, value } = answerFor(n, behaviour, request, truth);
      const chunk: Chunk = { asked, said };
      calls.push(chunk);
      if (hold) {
        await new Promise<void>((release) => {
          chunk.release = release;
        });
      }
      if (said.outcome === "rejects") {
        throw new Error("unavailable");
      }
      return value as DecisionSet;
    },
  };
  const session = createAuthorizationSession({ app: APP, transport, maxPairsPerRequest: cap });
  const x: Expected = { status: "IDLE", menu: new Map(), cache: new Map(), closed: false };
  const asks = (): boolean => !x.closed && (x.status === "READY" || x.status === "UNAVAILABLE");

  const drawRequest = (single: boolean): DecisionRequest =>
    single
      ? { resourceType: n.pick(TYPES), actions: [n.pick(ACTIONS)], resourceIds: [n.pick(IDS)] }
      : { resourceType: n.pick(TYPES), actions: n.some(ACTIONS, n.chance(0.03) ? 0 : 1, 3), resourceIds: n.some(IDS, 1, 5) };

  /** What a call that has settled should have returned, and the cache after it. */
  const judge = (
    request: DecisionRequest,
    returned: readonly Decision[],
    chunks: readonly Chunk[],
    hit: Answered | undefined,
    asked: boolean,
  ): string | undefined => {
    const where = `decide ${describeRequest(request)} under a cap of ${cap}`;
    if (!asked) {
      if (chunks.length > 0 || returned.length > 0) {
        return `${where}: a session that answers nothing asked ${chunks.length} chunks and returned ${returned.length} decisions`;
      }
      return undefined;
    }
    if (hit !== undefined) {
      count(tally.counts, "a call answered from the cache");
      if (chunks.length > 0) {
        return `${where}: the cache held every pair, and the transport was asked ${chunks.length} times`;
      }
      const problem = differs(request, returned, hit);
      return problem === undefined ? undefined : `${where}, from the cache: ${problem}`;
    }
    const wrong = handedWrong(request, chunks, cap);
    if (wrong !== undefined) {
      return `${where}: ${wrong}`;
    }
    const expected = fromChunks(request, chunks, tally);
    settle(x.cache, request, expected, tally);
    const problem = differs(request, returned, expected);
    return problem === undefined ? undefined : `${where}, chunks said ${chunks.map((c) => c.said.outcome).join("/")}: ${problem}`;
  };

  const decideOnce = async (request: DecisionRequest): Promise<string | undefined> => {
    const asked = asks();
    const hit = asked ? fromCache(x.cache, request) : undefined;
    const from = calls.length;
    const settled = await outcome(session.decide(request));
    if ("rejected" in settled) {
      return `decide ${describeRequest(request)} rejected: ${settled.rejected}`;
    }
    return judge(request, settled.value, calls.slice(from), hit, asked);
  };

  const start = async (): Promise<string | undefined> => {
    menu = drawMenu(n);
    count(tally.menus, menu.kind);
    const before = menus;
    const settled = await outcome(session.start());
    if ("rejected" in settled) {
      return `start() rejected: ${settled.rejected}`;
    }
    if (x.closed) {
      return menus === before ? undefined : "start() after close() asked the transport";
    }
    x.cache.clear();
    x.status = menu.status;
    x.menu = menu.entries;
    return undefined;
  };

  const stateDiffers = (): string | undefined => {
    const state = session.getState();
    if (state.status !== x.status) {
      return `the state is ${state.status}, expected ${x.status}`;
    }
    if (state.status === "READY") {
      if (state.permissions.length !== x.menu.size) {
        return `READY holds ${state.permissions.length} entries, expected ${x.menu.size}`;
      }
      for (const action of [...ACTIONS, "export"]) {
        const got = permissionFor(state.permissions, action);
        const want = x.menu.get(action) ?? "DENY";
        if (got !== want) {
          return `READY answers ${action} ${got}, expected ${want}`;
        }
      }
    }
    return undefined;
  };

  const STEP_KINDS = [
    [5, "one pair"],
    [6, "several pairs"],
    [2, "the backend changes its answer"],
    [2, "start"],
    [2, "two calls in flight"],
    [1, "start while a call is in flight"],
    [0.3, "close"],
  ] as const;

  for (let step = 0; step < STEPS; step += 1) {
    const kind = step === 0 && n.chance(0.85) ? "start" : n.weighted(STEP_KINDS);
    count(tally.steps, kind);
    let problem: string | undefined;
    switch (kind) {
      case "one pair":
      case "several pairs":
        problem = await decideOnce(drawRequest(kind === "one pair"));
        break;
      case "the backend changes its answer":
        for (let i = 0, changes = 1 + n.below(3); i < changes; i += 1) {
          backend.set(keyOf(n.pick(TYPES), n.pick(ACTIONS), n.pick(IDS)), n.pick(EFFECTS));
        }
        break;
      case "start":
        problem = await start();
        break;
      case "close":
        session.close();
        x.closed = true;
        x.status = "IDLE";
        x.cache.clear();
        break;
      case "two calls in flight": {
        const first = drawRequest(n.chance(0.4));
        const second = drawRequest(n.chance(0.4));
        const asked = asks();
        // Both are judged against the cache as it is when they are made: neither has been answered.
        const hits = [asked ? fromCache(x.cache, first) : undefined, asked ? fromCache(x.cache, second) : undefined];
        hold = true;
        const a = calls.length;
        const firstCall = outcome(session.decide(first));
        const b = calls.length;
        const secondCall = outcome(session.decide(second));
        const c = calls.length;
        hold = false;
        const pending = [
          { request: first, call: firstCall, chunks: calls.slice(a, b), hit: hits[0] },
          { request: second, call: secondCall, chunks: calls.slice(b, c), hit: hits[1] },
        ];
        if (n.chance(0.5)) {
          pending.reverse();
          if (pending.every((p) => p.chunks.length > 0)) {
            count(tally.counts, "two calls answered in the reverse of the order they were made");
          }
        }
        for (const p of pending) {
          p.chunks.forEach((chunk) => chunk.release?.());
          const settled = await p.call;
          problem ??=
            "rejected" in settled
              ? `decide ${describeRequest(p.request)} rejected: ${settled.rejected}`
              : judge(p.request, settled.value, p.chunks, p.hit, asked);
        }
        break;
      }
      case "start while a call is in flight": {
        const request = drawRequest(false);
        if (!asks() || fromCache(x.cache, request) !== undefined || distinctPairs(request).size === 0) {
          problem = (await decideOnce(request)) ?? (await start());
          break;
        }
        count(tally.counts, "a call in flight when start() landed");
        menu = drawMenu(n);
        count(tally.menus, menu.kind);
        const plan = menu;
        let starting: Promise<void> | undefined;
        onFetch = () => {
          starting = session.start();
        };
        const settled = await outcome(session.decide(request));
        const started = await outcome(starting ?? Promise.resolve());
        x.cache.clear();
        x.status = plan.status;
        x.menu = plan.entries;
        if ("rejected" in settled) {
          problem = `decide ${describeRequest(request)} rejected: ${settled.rejected}`;
        } else if ("rejected" in started) {
          problem = `start() rejected: ${started.rejected}`;
        } else if (settled.value.length > 0) {
          problem = `decide ${describeRequest(request)}: a call a start() overtook returned ${settled.value.length} decisions`;
        }
        break;
      }
    }
    problem ??= stateDiffers();
    if (problem !== undefined) {
      return `seed ${seed}, step ${step} (${kind}): ${problem}`;
    }
  }

  // Every pair the cache could hold, asked alone, from a transport that answers what it is asked.
  if (asks()) {
    force = "every pair";
    for (const resourceType of TYPES) {
      for (const action of ACTIONS) {
        for (const resourceId of [...IDS, ADDED_ID]) {
          const problem = await decideOnce({ resourceType, actions: [action], resourceIds: [resourceId] });
          if (problem !== undefined) {
            return `seed ${seed}, after the last step: ${problem}`;
          }
        }
      }
    }
    force = undefined;
  }
  session.close();
  return undefined;
}

describe("every place a session answers a pair from, over many sequences of calls", () => {
  it(`answers each pair as the chunks that asked for it said, in the last call answered that asked for it — in what a call returns, in the cache and in READY — over ${SEQUENCES} sequences`, async () => {
    const tally: Tally = { behaviours: new Map(), menus: new Map(), steps: new Map(), counts: new Map() };
    const problems: string[] = [];
    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      const problem = await sequence(seed, tally);
      if (problem !== undefined) {
        problems.push(problem);
      }
    }

    expect({ failed: problems.length, first: problems.slice(0, 8) }).toEqual({ failed: 0, first: [] });

    // And the sequences reached what the rules speak of: a pass over sequences that never met a case
    // says nothing about it.
    expect(BEHAVIOURS.filter(([, behaviour]) => (tally.behaviours.get(behaviour) ?? 0) === 0)).toEqual([]);
    expect(STEP_KINDS_NAMES.filter((kind) => (tally.steps.get(kind) ?? 0) === 0)).toEqual([]);
    expect(MENU_KINDS.filter((kind) => (tally.menus.get(kind) ?? 0) === 0)).toEqual([]);
    expect(COUNTED.filter((what) => (tally.counts.get(what) ?? 0) === 0)).toEqual([]);
  });
});

const STEP_KINDS_NAMES = [
  "one pair",
  "several pairs",
  "the backend changes its answer",
  "start",
  "two calls in flight",
  "start while a call is in flight",
  "close",
];
const MENU_KINDS = [
  "entries",
  "no entries",
  "rejects, no access",
  "rejects, unavailable",
  "rejects with a plain error",
  "another label",
  "no answer",
  "not a list",
  "an entry that cannot be read",
  "only entries that name no action",
];
const COUNTED = [
  "a call answered from the cache",
  "a cached pair left absent by a later call",
  "a pair made more restrictive by a chunk that did not ask for it",
  "a call left empty by an answer that could not be read",
  "two calls answered in the reverse of the order they were made",
  "a call in flight when start() landed",
];
