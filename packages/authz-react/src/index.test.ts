import { describe, expect, it } from "vitest";

import * as api from "./index.js";
import type { AuthzProviderProps, AuthzSnapshot, AuthzStatus, DecisionLookup } from "./index.js";

/**
 * The barrel is the package: what is not exported here does not exist for a consumer, however well
 * it is tested inside. `src/index.ts` is not excluded from coverage either, so a dropped export
 * line cannot show up as neither a failing test nor a gap.
 */
describe("the public surface", () => {
  it("exports every runtime value the package promises, and nothing else", () => {
    expect(Object.keys(api).sort()).toEqual([
      "AuthzProvider",
      "PermissionGuard",
      "useAuthz",
      "useAuthzSession",
      "useDecisions",
      "usePermission",
      "usePermissionEffect",
    ]);
  });

  it("each one is a function", () => {
    for (const value of Object.values(api)) {
      expect(typeof value).toBe("function");
    }
  });

  it("exports the types, which is asserted by this file compiling", () => {
    const declared: {
      props?: AuthzProviderProps;
      snapshot?: AuthzSnapshot;
      status?: AuthzStatus;
      lookup?: DecisionLookup;
    } = {};
    expect(declared).toEqual({});
  });
});
