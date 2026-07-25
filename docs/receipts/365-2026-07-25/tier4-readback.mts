/**
 * #365 tier-4 readback harness. Writes every secret kind into a real on-disk managed configuration
 * store and reads each one back, asserting the value round-trips at its exact expected shape.
 *
 * The run's nonce is carried as the value of a scratch secret (the Braintrust API key), so the
 * no-secret-in-logs criterion is tested against a value that cannot have pre-existed anywhere.
 * The harness never prints a secret value — only the kind, its key shape, and a SHA-256 of the
 * round-tripped JSON, which is the identifier the receipt correlates on.
 *
 *   node --experimental-strip-types docs/receipts/365-2026-07-25/tier4-readback.mts <db-path> <nonce>
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import {
  createManagedConfigStore,
  MANAGED_SECRET_KINDS,
  type ManagedSecretKind,
} from "../../../packages/installation/src/managed-config-store.ts";

const [databasePath, nonce] = process.argv.slice(2);
if (!databasePath || !nonce) throw new Error("usage: tier4-readback.mts <db-path> <nonce>");

const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
const githubApp = {
  schemaVersion: 1,
  kind: "github-app",
  appId: "12345",
  installationId: "67890",
  privateKey: PRIVATE_KEY,
};

const SECRETS: Record<ManagedSecretKind, unknown> = {
  "github-app:coder": githubApp,
  "github-app:reviewer": githubApp,
  "github-app:planner": { ...githubApp, webhookSecret: `${nonce}-hook` },
  "chatgpt-oauth": { type: "oauth", access: `${nonce}-access`, refresh: `${nonce}-refresh`, expires: 1_800_000_000 },
  "model-api-key": { schemaVersion: 1, kind: "api-key", provider: "anthropic", apiKey: `${nonce}-model` },
  e2b: { schemaVersion: 1, kind: "e2b", apiKey: `${nonce}-e2b` },
  // The scratch secret: the run's nonce, verbatim, as a stored secret value.
  braintrust: { schemaVersion: 1, kind: "braintrust", apiKey: nonce },
  "control-plane": { schemaVersion: 1, kind: "control-plane", token: `${nonce}-cp` },
};

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const store = createManagedConfigStore(databasePath);
console.log(`store: ${databasePath}  mode: 0${(statSync(databasePath).mode & 0o777).toString(8)}`);
console.log("kind                  written  read-back  shape                                        sha256-16");

let failures = 0;
for (const kind of MANAGED_SECRET_KINDS) {
  const written = SECRETS[kind];
  store.writeSecret(kind, written as never);
  const readBack = store.readSecret(kind);
  const identical = JSON.stringify(readBack) === JSON.stringify(written);
  if (!identical) failures += 1;
  const shape = Object.keys(readBack ?? {}).sort().join(",");
  console.log(
    `${kind.padEnd(21)} ${digest(written)} ${identical ? "IDENTICAL" : "DIFFERENT"}  ${shape.padEnd(44)} ${digest(readBack)}`,
  );
}

console.log(`stored kinds: ${store.storedSecretKinds().join(" ")}`);

// The nonce must not reach a validation failure's text (SEC-WO).
let failureText = "";
try {
  store.writeSecret("braintrust", { schemaVersion: 99, kind: "braintrust", apiKey: nonce } as never);
} catch (cause) {
  failureText = cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause);
}
const leaked = failureText.includes(nonce);
if (leaked) failures += 1;
console.log(`refusal text carries the nonce: ${leaked ? "YES (LEAK)" : "no"} — message: ${failureText.split("\n")[0]}`);

// The refused write left the previously stored value intact and readable.
const survivor = store.readSecret("braintrust");
const intact = JSON.stringify(survivor) === JSON.stringify(SECRETS.braintrust);
if (!intact) failures += 1;
console.log(`braintrust row after the refused write: ${intact ? "UNCHANGED" : "DAMAGED"} ${digest(survivor)}`);

store.close();
console.log(failures === 0 ? "TIER 4 READBACK: PASS" : `TIER 4 READBACK: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
