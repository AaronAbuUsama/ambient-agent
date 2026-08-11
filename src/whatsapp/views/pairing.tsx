import { useTheme } from "agentic-tui-kit";
import { useMemo } from "react";
import { qrColors, renderQr } from "../qr";

/**
 * The live pairing challenge, drawn large enough for a phone camera.
 *
 * @remarks
 * The grid only scans light-on-dark, so every row is drawn with
 * {@link qrColors} rather than the workbench theme — a themed QR is a
 * decorative one. Half-block rows also mean the code needs about twice as many
 * columns as character rows; when the pane cannot give it that, saying which
 * size would work beats drawing a clipped code that silently fails to scan.
 *
 * The status shares the footer rather than taking a row of its own: one row is
 * two QR modules, and this view is already the tightest thing in the workbench.
 */
export function PairingView({
  payload,
  status,
  width,
  height,
}: {
  payload: string;
  status: string;
  width: number;
  height: number;
}) {
  const { theme } = useTheme();
  const code = useMemo(() => renderQr(payload), [payload]);

  if (!code) {
    return (
      <box width={width} height={height} padding={1} flexDirection="column">
        <text fg={theme.negative}>WhatsApp sent a pairing code this build cannot draw.</text>
        <text fg={theme.textDim}>Press x to reconnect and request a new one.</text>
      </box>
    );
  }

  const needed = code.rows.length + 2;
  if (code.width > width || needed > height) {
    return (
      <box width={width} height={height} padding={1} flexDirection="column">
        <text fg={theme.warning}>Terminal too small to show the pairing code.</text>
        <text fg={theme.textDim}>
          {`Need ${code.width}×${needed} in this pane, have ${width}×${height}.`}
        </text>
        <text fg={theme.textDim}>Resize the terminal; the code redraws itself.</text>
        <text fg={theme.textMuted}>{`WhatsApp says: ${status}`}</text>
      </box>
    );
  }

  return (
    <box width={width} height={height} flexDirection="column" alignItems="center">
      <box height={1} width={width}>
        <text fg={theme.textBright}>Scan with WhatsApp → Settings → Linked devices</text>
      </box>
      <box width={code.width} flexDirection="column" data-app-role="pairing-qr">
        {code.rows.map((row, index) => (
          <text
            key={index}
            fg={qrColors.foreground}
            bg={qrColors.background}
            wrapMode="none"
            selectable={false}
          >
            {row}
          </text>
        ))}
      </box>
      <box height={1} width={width} flexDirection="row">
        <text fg={theme.warning}>{status}</text>
        <text fg={theme.textDim}> · the code refreshes itself until you scan it</text>
      </box>
    </box>
  );
}
