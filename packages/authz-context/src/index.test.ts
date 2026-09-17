import { describe, expect, it } from "vitest";

import * as api from "./index.js";
import type {
  AuthorizationContext,
  ContextDiagnostic,
  ContextSession,
  ContextSessionOptions,
  ContextSessionState,
  ContextTransport,
} from "./index.js";

/**
 * The barrel is the package: what is not exported here does not exist for a consumer, however well
 * it is tested inside. `src/index.ts` is not excluded from coverage either, so a dropped export
 * line cannot show up as neither a failing test nor a gap.
 */
describe("the public surface", () => {
  it("exports every runtime value the package promises", () => {
    expect(Object.keys(api).sort()).toEqual(["createContextSession"]);
  });

  it("each one is of the kind a consumer would call it as", () => {
    expect(typeof api.createContextSession).toBe("function");
  });

  it("exports the types, which is asserted by this file compiling", () => {
    const witness: {
      context?: AuthorizationContext;
      transport?: ContextTransport;
      session?: ContextSession;
      options?: ContextSessionOptions;
      state?: ContextSessionState;
      diagnostic?: ContextDiagnostic;
    } = {};
    expect(witness).toEqual({});
  });
});
