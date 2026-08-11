import generateQr from "qrcode-terminal";

/**
 * A pairing QR ready to draw in a terminal cell grid.
 *
 * @remarks
 * `qrcode-terminal`'s compact mode packs two QR rows into one character row
 * using half blocks, so a `rows.length × width` cell grid is roughly square on
 * a terminal whose cells are twice as tall as they are wide. The glyphs mark
 * *light* modules — `█` is two light modules, a space is two dark ones — so the
 * grid only scans when it is drawn light-on-dark. {@link qrColors} carries the
 * pair a renderer must use rather than leaving each call site to rediscover the
 * polarity from the glyphs.
 */
export interface QrCode {
  readonly rows: readonly string[];
  readonly width: number;
}

/** The only colour pair {@link QrCode.rows} scans under. */
export const qrColors = { foreground: "#ffffff", background: "#000000" } as const;

/**
 * Render a pairing payload as terminal half-block rows.
 *
 * @param payload - The `qr` string from a `challenge_live` pairing state.
 * @returns The drawable grid, or `null` when the payload cannot be encoded.
 *
 * @remarks
 * `qrcode-terminal` reports an encoding failure by throwing, and a QR that
 * failed to encode is a state a pairing view has to show rather than a crash
 * that takes the workbench down with it — WhatsApp chooses the payload, so its
 * length is not ours to guarantee.
 */
export function renderQr(payload: string): QrCode | null {
  if (payload.length === 0) return null;

  let output = "";
  try {
    generateQr.generate(payload, { small: true }, (drawn: string) => {
      output = drawn;
    });
  } catch {
    return null;
  }

  const rows = output.split("\n").filter((row) => row.trim().length > 0);
  if (rows.length === 0) return null;

  const width = Math.max(...rows.map((row) => row.length));
  return { rows: rows.map((row) => row.padEnd(width, " ")), width };
}
