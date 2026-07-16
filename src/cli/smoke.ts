import { readManagedConfig, readManagedGitHubCredential } from "../managed/configuration.js";
import { runtimeSmokeAuthorization } from "../managed/runtime-health.js";
import type { ManagedPaths } from "../managed/paths.js";
import type { InspectionReport } from "./rendering.js";

export interface SmokeCanaryReceipt {
  readonly chatId: string;
  readonly text: string;
  readonly stages: readonly ["admission", "dispatch", "settled-silent"];
}

export type SmokeCanary = (paths: ManagedPaths, nonce: string, timeoutMillis: number) => Promise<SmokeCanaryReceipt>;

export const requestRuntimeSmokeCanary: SmokeCanary = async (paths, nonce, timeoutMillis) => {
  const configuration = await readManagedConfig(paths.config);
  if (configuration.smoke === undefined) {
    throw new Error("No dedicated smoke canary group is configured; run ambient-agent config --canary-chat <group-jid>.");
  }
  const credential = await readManagedGitHubCredential(paths.githubCredential);
  if (credential.webhookSecret === undefined) throw new Error("The runtime installation identity is unavailable.");
  const signal = AbortSignal.timeout(timeoutMillis + 1_000);
  const response = await fetch(`http://127.0.0.1:${configuration.runtime.port}/smoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ambient-agent-smoke": runtimeSmokeAuthorization(credential.webhookSecret, nonce, timeoutMillis),
    },
    body: JSON.stringify({ nonce, timeoutMillis }),
    signal,
  });
  const body = (await response.json().catch(() => undefined)) as SmokeCanaryReceipt | { readonly error?: unknown } | undefined;
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "error" in body ? String(body.error) : `HTTP ${response.status}`;
    throw new Error(`The live canary failed: ${detail}`);
  }
  if (
    body === undefined ||
    !("chatId" in body) ||
    !("text" in body) ||
    !("stages" in body) ||
    body.chatId !== configuration.smoke.canaryChat ||
    body.text !== `SMOKE ${nonce} — ignore` ||
    JSON.stringify(body.stages) !== JSON.stringify(["admission", "dispatch", "settled-silent"])
  ) {
    throw new Error("The live canary response was malformed or did not prove the required lifecycle.");
  }
  return body as SmokeCanaryReceipt;
};

interface SmokeStation {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export const smokeStations = async (
  report: InspectionReport,
  paths: ManagedPaths,
  nonce: string,
  timeoutMillis: number,
  canary: SmokeCanary,
): Promise<readonly SmokeStation[]> => {
  const config = report.installation.state === "ready" ? await readManagedConfig(paths.config).catch(() => undefined) : undefined;
  const deliveries = report.windowDeliveries;
  const githubAccess = report.checks.find(({ name }) => name === "github-access");
  const stations: SmokeStation[] = [
    {
      name: "installation",
      passed: report.installation.state === "ready" && report.checks.every(({ state }) => state !== "failed"),
      detail:
        report.installation.state === "ready"
          ? "managed installation ready"
          : `managed installation ${report.installation.state}`,
    },
    {
      name: "chatgpt",
      passed: report.authentication.state === "ready" && report.liveCheck?.request === "complete",
      detail:
        report.authentication.state === "ready" && report.liveCheck?.request === "complete"
          ? "authentication ready; live readiness complete"
          : `authentication ${report.authentication.state}; live readiness ${report.liveCheck?.request ?? "not run"}`,
    },
    {
      name: "runtime",
      passed: report.observedRuntime?.state === "healthy" && report.observedRuntime.whatsapp.phase === "online",
      detail:
        report.observedRuntime?.state === "healthy" && report.observedRuntime.whatsapp.phase === "online"
          ? "healthy; WhatsApp online"
          : `${report.observedRuntime?.state ?? "unobservable"}; WhatsApp ${report.observedRuntime?.whatsapp.phase ?? "unobservable"}`,
    },
    {
      name: "backlog",
      passed:
        deliveries?.pending === 0 &&
        deliveries.failed === 0 &&
        report.uncertainWork?.health === "healthy" &&
        report.uncertainWork.total === 0,
      detail:
        deliveries === undefined || report.uncertainWork === undefined
          ? "backlog unavailable"
          : `${deliveries.pending} pending, ${deliveries.failed} failed, ${report.uncertainWork.total === 0 ? "no" : report.uncertainWork.total} Uncertain work`,
    },
    {
      name: "github",
      passed: githubAccess?.state === "ready",
      detail:
        githubAccess?.state === "ready" && config !== undefined
          ? `access to ${config.github.defaultRepository}`
          : "GitHub reachability failed",
    },
  ];
  try {
    const receipt = await canary(paths, nonce, timeoutMillis);
    stations.push({
      name: "canary",
      passed:
        receipt.text === `SMOKE ${nonce} — ignore` &&
        JSON.stringify(receipt.stages) === JSON.stringify(["admission", "dispatch", "settled-silent"]),
      detail: `SMOKE ${nonce} settled silent (admission → dispatch → settled-silent)`,
    });
  } catch (cause) {
    stations.push({
      name: "canary",
      passed: false,
      detail: cause instanceof Error ? cause.message : "live canary failed",
    });
  }
  return stations;
};

export const renderSmokeStations = (stations: readonly SmokeStation[]): string =>
  `${stations.map(({ name, passed, detail }) => `${passed ? "PASS" : "FAIL"} ${name}: ${detail}`).join("\n")}\n`;
