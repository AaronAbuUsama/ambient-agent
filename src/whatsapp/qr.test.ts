import { expect, test } from "bun:test";
import { renderQr } from "./qr";

/**
 * Expand half-block rows back into the module grid they encode.
 *
 * @remarks
 * The renderer's contract is that a glyph marks a *light* module, so `█` is two
 * light modules and a space is two dark ones. Reading the grid back under that
 * rule is what makes the finder-pattern assertions below polarity-sensitive: if
 * the encoder ever inverted, every "dark" cell here would flip and no finder
 * would be found.
 */
function darkModules(rows: readonly string[], width: number): boolean[][] {
  const grid: boolean[][] = [];
  for (const row of rows) {
    const upper: boolean[] = [];
    const lower: boolean[] = [];
    for (let column = 0; column < width; column += 1) {
      const glyph = row[column] ?? " ";
      upper.push(glyph === " " || glyph === "▄");
      lower.push(glyph === " " || glyph === "▀");
    }
    grid.push(upper, lower);
  }
  return grid;
}

/** The canonical 7×7 QR position-detection pattern: a dark ring around a 3×3 core. */
function isFinder(grid: readonly boolean[][], top: number, left: number): boolean {
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const ring = y === 0 || y === 6 || x === 0 || x === 6;
      const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
      if (grid[top + y]?.[left + x] !== (ring || core)) return false;
    }
  }
  return true;
}

const payload =
  "2@rC3Kk1vT9pQwErTyUiOpAsDfGhJkLzXcVbNm1234567890+/=,AbCdEfGhIjKlMnOpQrStUvWxYz==,9876543210ZyXwVuTsRqPoNmLkJiHgFeDcBa+/=,1";

test("a pairing payload renders as a rectangular half-block grid", () => {
  const code = renderQr(payload);
  expect(code).not.toBeNull();
  expect(code!.rows.length).toBeGreaterThan(0);
  expect(new Set(code!.rows.map((row) => row.length))).toEqual(new Set([code!.width]));
  expect(new Set(code!.rows.join(""))).toEqual(new Set(["█", " ", "▀", "▄"]));
});

test("the rendered grid carries three finder patterns squared at the corners", () => {
  const code = renderQr(payload)!;
  const grid = darkModules(code.rows, code.width);

  const finders: Array<{ top: number; left: number }> = [];
  for (let top = 0; top + 7 <= grid.length; top += 1) {
    for (let left = 0; left + 7 <= code.width; left += 1) {
      if (isFinder(grid, top, left)) finders.push({ top, left });
    }
  }

  expect(finders).toHaveLength(3);
  const [topLeft, topRight, bottomLeft] = finders as [
    { top: number; left: number },
    { top: number; left: number },
    { top: number; left: number },
  ];
  expect(topRight.top).toBe(topLeft.top);
  expect(bottomLeft.left).toBe(topLeft.left);
  expect(topRight.left - topLeft.left).toBe(bottomLeft.top - topLeft.top);
});

test("an unencodable payload degrades to null instead of throwing", () => {
  expect(renderQr("")).toBeNull();
  expect(renderQr("x".repeat(10_000))).toBeNull();
});
