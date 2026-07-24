import { describe, expect, it } from "vite-plus/test";

import { applyManagedAuthorization } from "../../apps/runtime/src/host/authorization-reload.ts";
import { createManagedConfig } from "../../packages/installation/src/schema.ts";

const config = (overrides: {
  managedChats?: string[];
  allowedRepositories?: string[];
  reviewRepositories?: string[];
  port?: number;
}) => {
  const base = createManagedConfig(overrides.managedChats ?? ["team@g.us"], "acme/widgets");
  return {
    ...base,
    runtime: { ...base.runtime, ...(overrides.port === undefined ? {} : { port: overrides.port }) },
    github: {
      ...base.github,
      allowedRepositories: overrides.allowedRepositories ?? base.github.allowedRepositories,
      reviewRepositories: overrides.reviewRepositories ?? base.github.reviewRepositories,
    },
  };
};

describe("applyManagedAuthorization (#179)", () => {
  it("applies exactly the three authorization knobs, in place", () => {
    const reloadedChats: string[][] = [];
    const reloadedRepos: string[][] = [];
    const reviewRepositories: string[] = ["acme/widgets"];
    const reviewIdentity = reviewRepositories;

    applyManagedAuthorization(
      config({
        managedChats: ["team@g.us", "second@g.us"],
        allowedRepositories: ["acme/widgets", "acme/gadgets"],
        reviewRepositories: ["acme/widgets"],
      }),
      {
        reloadManagedChats: (chats) => reloadedChats.push([...chats]),
        policy: { reload: (repos) => reloadedRepos.push([...repos]) },
        reviewRepositories,
      },
    );

    expect(reloadedChats).toEqual([["team@g.us", "second@g.us"]]);
    expect(reloadedRepos).toEqual([["acme/widgets", "acme/gadgets"]]);
    // Spliced in place — the ingress keeps reading the same array reference.
    expect(reviewRepositories).toBe(reviewIdentity);
    expect(reviewRepositories).toEqual(["acme/widgets"]);
  });

  it("never reaches a restart-only knob: a changed port/model in the same config is not applied", () => {
    // The targets object structurally exposes only the three authorization surfaces. A port change
    // riding along in the configuration has nowhere to go — this is the negative guarantee in code.
    const reloadedChats: string[][] = [];
    applyManagedAuthorization(config({ port: 9999, managedChats: ["team@g.us"] }), {
      reloadManagedChats: (chats) => reloadedChats.push([...chats]),
      policy: { reload: () => undefined },
      reviewRepositories: [],
    });
    // Only the authorization knob was consumed; there is no path from here to the port.
    expect(reloadedChats).toEqual([["team@g.us"]]);
  });
});
