import { useTheme } from "agentic-tui-kit";
import type { ReactNode } from "react";
import type { HistoryPrefetchProgress } from "../../session/history-prefetch";
import { statusLabel } from "../presentation";
import type { WhatsAppSessionSnapshot } from "../../session/controller";
import { whatsAppActions } from "../../actions/ids";

/**
 * What the background history walk has done, in one line.
 *
 * @remarks
 * A background process nobody can see is indistinguishable from one that is
 * not running, and this one is the reason a chat opens already full.
 */
function historyPrefetchLabel(progress: HistoryPrefetchProgress): string {
  const { done, total, messages, state } = progress;
  switch (state) {
    case "idle":
      return "not connected";
    case "running":
      return `${messages} messages · ${done} of ${total} chats`;
    case "capped":
      return `${messages} messages · stopped at the memory limit, press o for more`;
    case "complete":
      return `${messages} messages · all ${total} chats`;
  }
}

/** One labelled fact about the account. */
function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const { theme } = useTheme();
  return (
    <box height={1} flexDirection="row">
      <box width={12}>
        <text fg={theme.textMuted}>{label}</text>
      </box>
      <text fg={tone ?? theme.text}>{value}</text>
    </box>
  );
}

/** A control that reaches an action, by key or by click. */
function Control({
  accelerator,
  label,
  detail,
  enabled,
  onRun,
}: {
  accelerator: string;
  label: string;
  detail: string;
  enabled: boolean;
  onRun: () => void;
}): ReactNode {
  const { theme } = useTheme();
  return (
    <box
      height={1}
      flexDirection="row"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (enabled) onRun();
      }}
      aria-label={label}
      data-app-role="settings-control"
    >
      <box width={5}>
        <text fg={enabled ? theme.warning : theme.textMuted}>{`[${accelerator}]`}</text>
      </box>
      <box width={22}>
        <text fg={enabled ? theme.textBright : theme.textMuted}>{label}</text>
      </box>
      <text fg={theme.textDim}>{detail}</text>
    </box>
  );
}

/**
 * The connection screen: what the account is doing, and every control that
 * changes it — including the pairing code, which belongs here rather than in a
 * modal because pairing *is* the connection lifecycle's first state.
 */
export function SettingsView({
  snapshot,
  width,
  height,
  onRun,
}: {
  snapshot: WhatsAppSessionSnapshot;
  width: number;
  height: number;
  onRun: (actionId: string) => void;
}) {
  const { theme } = useTheme();
  const online = snapshot.status?.phase === "online";
  const busy = snapshot.attachment === "attaching" || snapshot.attachment === "detaching";
  const identity = snapshot.identity;

  const headerHeight = snapshot.error ? 6 : 5;
  const bodyHeight = Math.max(1, height - headerHeight);

  return (
    <box width={width} height={height} flexDirection="column">
      <box height={1}>
        <text fg={theme.textBright}>
          <strong>CONNECTION</strong>
        </text>
      </box>
      <Field
        label="Status"
        value={statusLabel(snapshot.status)}
        tone={online ? theme.positive : busy ? theme.warning : theme.textDim}
      />
      <Field label="Attachment" value={snapshot.attachment} />
      <Field
        label="Account"
        value={
          identity
            ? `${identity.pushName ?? "linked"} · ${identity.phoneE164 ?? identity.jid}`
            : "not linked yet"
        }
      />
      {snapshot.error ? <Field label="Error" value={snapshot.error} tone={theme.negative} /> : null}
      <box height={1} />

      <box width={width} height={bodyHeight} flexDirection="column">
        <box height={1}>
          <text fg={theme.textBright}>
            <strong>CONTROLS</strong>
          </text>
        </box>
        <Control
          accelerator="c"
          label="Connect"
          detail="claim the account and open a session"
          enabled={snapshot.attachment === "detached"}
          onRun={() => onRun(whatsAppActions.connect)}
        />
        <Control
          accelerator="d"
          label="Disconnect"
          detail="release the account, keep credentials"
          enabled={snapshot.attachment !== "detached"}
          onRun={() => onRun(whatsAppActions.disconnect)}
        />
        <Control
          accelerator="x"
          label="Reconnect"
          detail="release and claim again"
          enabled={!busy}
          onRun={() => onRun(whatsAppActions.reconnect)}
        />
        <Control
          accelerator="u"
          label="Unlink this device"
          detail="erase credentials; next connect pairs again"
          enabled={!busy}
          onRun={() => onRun(whatsAppActions.unlink)}
        />
        <box height={1} />
        <box height={1}>
          <text fg={theme.textBright}>
            <strong>HISTORY</strong>
          </text>
        </box>
        <Field label="Mirrored" value={`${snapshot.chats.length} chats`} />
        <Field
          label="Loaded"
          value={historyPrefetchLabel(snapshot.historyPrefetch)}
          tone={snapshot.historyPrefetch.state === "capped" ? theme.warning : theme.text}
        />
      </box>
    </box>
  );
}
