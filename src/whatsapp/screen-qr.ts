/**
 * Lift a half-block QR out of a rendered terminal frame.
 *
 * @param frame - A captured character frame, borders and chrome included.
 * @returns The QR's own rows, or `null` when the frame carries no code.
 *
 * @remarks
 * Exists so a journey can decode the code a human would actually point a phone
 * at, rather than the value the renderer was handed. It keys on the four glyphs
 * the compact encoding uses and nothing else: the workbench's own chrome draws
 * with `─`, `│` and `▌`, none of which appear here, so the widest run of QR
 * glyphs on each line is the code and the rest of the screen is not.
 */
export function qrRowsFromFrame(frame: string): string[] | null {
  const glyphs = /[█▀▄]/;
  const candidates = frame.split("\n").filter((line) => glyphs.test(line));
  if (candidates.length === 0) return null;

  let left = Number.POSITIVE_INFINITY;
  let right = -1;
  for (const line of candidates) {
    for (let column = 0; column < line.length; column += 1) {
      if (!glyphs.test(line[column] ?? "")) continue;
      if (column < left) left = column;
      if (column > right) right = column;
    }
  }
  if (right < left) return null;

  return candidates.map((line) =>
    line
      .slice(left, right + 1)
      .padEnd(right + 1 - left, " ")
      // A cell the frame left blank is a light module, which is a space here.
      .replaceAll(/[^█▀▄ ]/gu, " "),
  );
}
