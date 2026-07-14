import type { ChatGptAuthentication } from "../model/chatgpt-authentication.js";

export interface ManagedRuntimeDependencies {
  readonly authentication: ChatGptAuthentication;
}

const RUNTIME_DEPENDENCIES = Symbol.for("ambient-agent.managed-runtime-dependencies");

type RuntimeGlobal = typeof globalThis & {
  [RUNTIME_DEPENDENCIES]?: ManagedRuntimeDependencies;
};

const runtimeGlobal = globalThis as RuntimeGlobal;

export const installManagedRuntimeDependencies = (next: ManagedRuntimeDependencies): void => {
  runtimeGlobal[RUNTIME_DEPENDENCIES] = next;
};

export const takeManagedRuntimeDependencies = (): ManagedRuntimeDependencies => {
  const dependencies = runtimeGlobal[RUNTIME_DEPENDENCIES];
  if (dependencies === undefined) {
    throw new Error("Managed runtime dependencies were not configured by the Ambient Agent CLI.");
  }
  delete runtimeGlobal[RUNTIME_DEPENDENCIES];
  return dependencies;
};
