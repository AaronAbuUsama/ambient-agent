import type { GraphAttestationContext } from "@ambient-agent/engine/graph/store.ts";

const contexts = new Map<string, GraphAttestationContext>();

export const scribeAttemptContext = (attemptId: string): GraphAttestationContext => {
  const context = contexts.get(attemptId);
  if (context === undefined) throw new Error(`Scribe attempt ${attemptId} has no trusted Attestation context.`);
  return context;
};

export const withScribeAttemptContext = async <T>(
  attemptId: string,
  context: GraphAttestationContext,
  run: () => Promise<T>,
): Promise<T> => {
  if (contexts.has(attemptId)) throw new Error(`Scribe attempt ${attemptId} is already active.`);
  contexts.set(attemptId, context);
  try {
    return await run();
  } finally {
    contexts.delete(attemptId);
  }
};
