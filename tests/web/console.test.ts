/**
 * The console's design-system discipline, enforced (#372).
 *
 * The rule is SHADCN: primitives are *installed* through the shadcn CLI, and everything this
 * project writes on top of them expresses colour and radius through the semantic tokens as
 * Tailwind utilities. So the check runs over the source this project authors and deliberately
 * exempts two directories the generators own:
 *
 * - `src/components/ui/` — registry output, added by `shadcn add`, never hand-authored here;
 * - `src/assets/` — the scaffold's own artwork.
 *
 * This is the check that keeps every later screen (#377–#382) honest, which is why it ships with
 * the shell rather than after it.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = process.cwd();
const consoleSource = "apps/web/src";
const generatorOwned = [path.join(consoleSource, "components", "ui"), path.join(consoleSource, "assets")];

/** Every file under the console source that this project authors, generator output excluded. */
async function authoredFiles(relativeDirectory: string): Promise<string[]> {
  if (generatorOwned.includes(relativeDirectory)) return [];
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return await authoredFiles(relativePath);
      return entry.isFile() ? [relativePath] : [];
    }),
  );
  return nested.flat();
}

/**
 * Comments stripped, so a `#372` in a doc comment is not read as the colour `#372`. Crude on
 * purpose: it may also blank a `//` inside a string literal, which costs this check nothing.
 */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");

describe("the console's design system", () => {
  it("resolves every colour and radius through the tokens: no hex, no inline style, no bespoke CSS", async () => {
    const files = await authoredFiles(consoleSource);
    expect(files.length, "the console has authored source to check").toBeGreaterThan(0);

    for (const relativePath of files) {
      const source = code(await readFile(path.join(root, relativePath), "utf8"));
      // A hex colour is a colour that did not come from a token.
      expect(source, relativePath).not.toMatch(/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/u);
      // An inline style attribute is a stylesheet with one rule in it.
      expect(source, relativePath).not.toMatch(/\sstyle=/u);
      // The one stylesheet is the generator's token file; a second one is a design system.
      expect(relativePath.endsWith(".css") && relativePath !== path.join(consoleSource, "index.css"), relativePath).toBe(
        false,
      );
    }

    // …and the generator's token file is still the only stylesheet in the tree at all.
    const stylesheets = (await authoredFiles(consoleSource)).filter((file) => file.endsWith(".css"));
    expect(stylesheets).toEqual([path.join(consoleSource, "index.css")]);
  });

  it("lists all seven destinations", async () => {
    const routes = await readFile(path.join(root, consoleSource, "routes.tsx"), "utf8");
    for (const [route, label] of [
      ["/", "Overview"],
      ["/chats", "Chats"],
      ["/repositories", "Repositories"],
      ["/agents", "Agents"],
      ["/runtime", "Runtime"],
      ["/secrets", "Secrets"],
      ["/logs", "Logs"],
    ]) {
      expect(routes, label).toMatch(new RegExp(`path:\\s*"${route}",\\s*label:\\s*"${label}"`, "u"));
    }
    // The sidebar renders whatever ROUTES holds, through the official primitive.
    const sidebar = await readFile(path.join(root, consoleSource, "components", "app-sidebar.tsx"), "utf8");
    expect(sidebar).toContain("ROUTES.map");
    expect(sidebar).toContain('from "@/components/ui/sidebar"');
  });
});
