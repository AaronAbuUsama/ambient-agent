import { describe, expect, it } from "vite-plus/test";

import { slugify } from "@ambient-agent/engine/shared/slugify.ts";

describe("slugify", () => {
  it("lowercases and trims padded mixed-case input", () => {
    expect(slugify("  HeLLo   WORLd  ")).toBe("hello-world");
  });

  it("collapses mixed internal whitespace into single dashes", () => {
    expect(slugify("Line\tBreak\nVALUE")).toBe("line-break-value");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(slugify("   ")).toBe("");
  });
});
