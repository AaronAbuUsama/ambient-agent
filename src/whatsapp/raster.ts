/** RGBA pixels in the shape a QR decoder expects. */
export interface Raster {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Rebuild the pixels a phone camera would see from half-block QR rows.
 *
 * @param rows - QR rows, either from `renderQr` or lifted off a frame.
 * @param scale - Pixels per module. Six is comfortably above the decoder's
 * sampling floor without making a long payload slow to decode.
 *
 * @remarks
 * This is proof machinery, not a runtime path: it exists so a test can hand a
 * real decoder the same light-and-dark grid the pairing view puts on screen —
 * white glyphs on black — and assert the payload survives. Each glyph becomes
 * two stacked square modules, which is the aspect a terminal cell already has.
 */
export function rasterizeQrRows(rows: readonly string[], scale = 6): Raster {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const pixelWidth = width * scale;
  const pixelHeight = rows.length * 2 * scale;
  const data = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);

  for (const [row, line] of rows.entries()) {
    for (let column = 0; column < width; column += 1) {
      const glyph = line[column] ?? " ";
      const halves = [glyph === " " || glyph === "▄", glyph === " " || glyph === "▀"];
      for (const [half, dark] of halves.entries()) {
        const moduleY = row * 2 + half;
        const level = dark ? 0 : 255;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const offset = ((moduleY * scale + y) * pixelWidth + column * scale + x) * 4;
            data[offset] = level;
            data[offset + 1] = level;
            data[offset + 2] = level;
            data[offset + 3] = 255;
          }
        }
      }
    }
  }

  return { data, width: pixelWidth, height: pixelHeight };
}
