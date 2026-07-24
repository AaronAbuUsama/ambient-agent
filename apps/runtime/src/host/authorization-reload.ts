import type { ManagedConfig } from "@ambient-agent/installation/schema.ts";
import type { IssueManagementPolicy } from "@ambient-agent/agents/capabilities/issue-management/runtime.ts";

/**
 * The three in-place authorization surfaces a live reload rebuilds (#179). Everything else in the
 * managed configuration — the WhatsApp session, model provider, port, sandbox — is deliberately
 * absent: those are restart-only and are never reachable from a reload, so a change to them can never
 * be silently hot-swapped.
 */
export interface ManagedAuthorizationTargets {
  /** The chat gate's live-reload (a no-op if the WhatsApp runtime is not online yet). */
  readonly reloadManagedChats: (chatIds: readonly string[]) => void;
  /** The GitHub write allowlist policy. */
  readonly policy: Pick<IssueManagementPolicy, "reload">;
  /** The Reviewer ingress allowlist — a mutable array the ingress reads live; rebuilt in place. */
  readonly reviewRepositories: string[];
}

/**
 * Apply the authorization knobs of a freshly-read configuration to the live runtime (#179). Reads only
 * `managedChats`, `github.allowedRepositories`, and `github.reviewRepositories`; a WhatsApp/model/port
 * change carried in the same configuration is structurally unreachable here and therefore never applied.
 */
export const applyManagedAuthorization = (config: ManagedConfig, targets: ManagedAuthorizationTargets): void => {
  targets.reloadManagedChats(config.managedChats);
  targets.policy.reload(config.github.allowedRepositories);
  targets.reviewRepositories.splice(0, targets.reviewRepositories.length, ...config.github.reviewRepositories);
};

/**
 * Reload authorization on SIGHUP — the idiomatic Unix "re-read your config" signal, and the operator's
 * trigger for a live authorization change (write the new values, then `kill -HUP` / `systemctl reload`).
 * It touches nothing about the WhatsApp session, so it can never disturb the single-home session store.
 */
export const reloadAuthorizationOnSignal = (reload: () => void): void => {
  process.on("SIGHUP", () => {
    try {
      reload();
    } catch (cause) {
      process.stderr.write(`Authorization reload on SIGHUP failed: ${String(cause)}\n`);
    }
  });
};
