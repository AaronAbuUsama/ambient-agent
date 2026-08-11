import { expect, test } from "bun:test";
import jsQR from "jsqr";
import { renderQr } from "./qr";
import { rasterizeQrRows } from "./raster";

/**
 * The only assertion that proves the rendered code is *scannable* rather than
 * merely QR-shaped: the drawn light-and-dark grid goes through the same
 * decoding algorithm a phone runs, and must give the payload back. A polarity
 * flip, a dropped quiet zone, or a mangled row fails here and nowhere else.
 */
test.each([
  [
    "a WhatsApp-shaped pairing payload",
    "2@aB3/kQ9wErTyUiOpAsDfGhJkLzXcVbNm+/=,QwErTyUiOp+/=,ZxCvBnMaSd+/=,1",
  ],
  ["a short payload", "link-me"],
  ["a long payload", `2@${"K".repeat(180)},${"M".repeat(43)},${"N".repeat(43)},1`],
])("the rendered grid decodes back to %s", (_name, payload) => {
  const code = renderQr(payload);
  expect(code).not.toBeNull();

  const image = rasterizeQrRows(code!.rows);
  const decoded = jsQR(image.data, image.width, image.height);

  expect(decoded).not.toBeNull();
  expect(decoded!.data).toBe(payload);
});
