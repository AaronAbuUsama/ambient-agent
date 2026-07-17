import { describe, expect, it } from "vite-plus/test";

import * as ambienceModule from "../../packages/agents/src/ambience/agent.ts";

describe("Ambience admission boundary", () => {
  it("does not expose the production agent through an unauthenticated HTTP route", () => {
    expect(ambienceModule).not.toHaveProperty("route");
  });
});
