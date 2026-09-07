import { describe, expect, it } from "vitest";

import * as api from "./index.js";
import type {
  AuthorizationSession,
  AuthorizationSessionOptions,
  AuthorizationState,
  AuthorizationTransport,
  Decision,
  DecisionEffect,
  DecisionRequest,
  DecisionSet,
  PermissionEntry,
  PermissionMenu,
  TransportErrorKind,
} from "./index.js";

/**
 * The barrel is the package: what is not exported here does not exist for a consumer, however
 * well it is tested inside. Until this file existed nothing imported `./index.js` at all — and
 * `src/index.ts` was excluded from coverage, so a dropped export line showed up as neither a
 * failing test nor a coverage gap. That exclusion is gone with this test.
 */
describe("the public surface", () => {
  it("exports every runtime value the package promises", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "AuthorizationTransportError",
        "createAuthorizationSession",
        "decisionFor",
        "isRenderable",
        "permissionFor",
        "splitDecisionRequest",
      ].sort(),
    );
  });

  it("each one is of the kind a consumer would call it as", () => {
    expect(typeof api.isRenderable).toBe("function");
    expect(typeof api.decisionFor).toBe("function");
    expect(typeof api.permissionFor).toBe("function");
    expect(typeof api.splitDecisionRequest).toBe("function");
    expect(typeof api.createAuthorizationSession).toBe("function");
    // A class, not a factory: consumers narrow on it with `instanceof`.
    expect(typeof api.AuthorizationTransportError).toBe("function");
    expect(new api.AuthorizationTransportError("UNAVAILABLE", "x")).toBeInstanceOf(Error);
  });

  /**
   * The type-only exports have no runtime footprint, so the assertion is that this file
   * COMPILES: every name below is imported from `./index.js` above, and `pnpm typecheck`
   * fails if any of them stops being exported.
   */
  it("exports the types, which is asserted by this file compiling", () => {
    const witness: {
      effect?: DecisionEffect;
      entry?: PermissionEntry;
      decision?: Decision;
      transport?: AuthorizationTransport;
      request?: DecisionRequest;
      set?: DecisionSet;
      menu?: PermissionMenu;
      kind?: TransportErrorKind;
      session?: AuthorizationSession;
      options?: AuthorizationSessionOptions;
      state?: AuthorizationState;
    } = {};
    expect(witness).toEqual({});
  });
});
