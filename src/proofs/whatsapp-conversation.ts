import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { loadAppConfig } from "../app/config";
import { createAppResources } from "../app/resources";
import { createPiConversationAgent } from "../conversation/pi-agent";
import { createConversationService } from "../conversation/service";
import { agentRuns, evaluationRuns, toolCalls } from "../database/schema";
import { createModelRuntime } from "../models/runtime";

const timeoutMs = 180_000;
const pollMs = 500;
const targetHint = process.env.PROOF_WHATSAPP_TARGET_HINT?.trim().toLocaleLowerCase();
if (!targetHint) {
  throw new Error("PROOF_WHATSAPP_TARGET_HINT must identify the authorized test group or +44 chat");
}

const config = loadAppConfig({
  ...process.env,
  CONVERSATION_ENABLED: "false",
  CONVERSATION_INSTRUCTIONS:
    process.env.CONVERSATION_INSTRUCTIONS ??
    "This is a controlled Ambient Phase 2B proof. Reply once with a brief acknowledgement.",
});
// Fail closed on credentials and model resolution before any WhatsApp use.
const conversationRunner = createModelRuntime(config.models).forRole("conversation");
const acceptedMessages: Array<{
  readonly observationId: string;
  readonly conversationId: string;
}> = [];
const resources = await createAppResources(config, (result) => acceptedMessages.push(result));

const authorized = (): { readonly id: string; readonly label: string } => {
  const snapshot = resources.whatsapp.getSnapshot();
  // A tiny proof-only selector whose branches are the destination safety guard.
  // fallow-ignore-next-line complexity
  const candidates = snapshot.chats.flatMap((chat) => {
    const group = chat.isGroup
      ? snapshot.groups.find(({ groupId }) => groupId === chat.chatId)
      : undefined;
    const label = group?.subject ?? chat.subject ?? chat.chatId;
    return `${label} ${chat.chatId}`.toLocaleLowerCase().includes(targetHint)
      ? [{ id: chat.chatId, label }]
      : [];
  });
  if (candidates.length !== 1) {
    throw new Error(
      `proof target hint matched ${candidates.length} chats; use a unique test-group name or +44 identifier`,
    );
  }
  return candidates[0]!;
};

const waitFor = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("Phase 2B live proof timed out");
};

const client = createClient({ url: config.database.url });
const database = drizzle(client);
try {
  await resources.whatsapp.attach();
  const target = authorized();
  const existingRuns = new Set(
    (
      await database
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.conversationId, target.id))
    ).map(({ id }) => id),
  );
  console.info(`Authorized proof target: ${target.label} (${target.id})`);
  console.info("Send one new inbound text message in that chat now.");

  const observed = await waitFor(async () =>
    acceptedMessages.find(({ conversationId }) => conversationId === target.id),
  );
  await new Promise((resolve) => setTimeout(resolve, config.conversation.scheduling.debounceMs));
  const scheduler = createConversationService({
    scheduling: config.conversation.scheduling,
    instructions: config.conversation.instructions,
    work: resources.database.repositories.conversationWork,
    recall: resources.database.repositories.memory,
    evaluation: resources.database.repositories.conversationEvaluation,
    agent: createPiConversationAgent(conversationRunner),
    sender: {
      // The guard is intentionally repeated at the last side-effect boundary.
      // fallow-ignore-next-line complexity
      async sendText({ conversationId, text, idempotencyKey }) {
        if (conversationId !== target.id) {
          throw new Error(`proof refused unauthorized destination "${conversationId}"`);
        }
        const operation = await resources.whatsapp.sendText(target.id, text, idempotencyKey);
        return { operationId: operation.id };
      },
    },
  });
  await resources.database.repositories.conversationWork.notify(
    target.id,
    config.conversation.scheduling,
  );
  await waitFor(async () => {
    const outcome = await scheduler.runOnce();
    return outcome === "idle" ? undefined : outcome;
  });

  // Terminal-state filtering is proof evidence, not product control flow.
  // fallow-ignore-next-line complexity
  const run = await waitFor(async () => {
    const [row] = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.conversationId, target.id))
      .orderBy(sql`${agentRuns.createdAt} DESC`)
      .limit(1);
    return row &&
      !existingRuns.has(row.id) &&
      (row.status === "succeeded" || row.status === "failed")
      ? row
      : undefined;
  });
  const calls = await database.select().from(toolCalls).where(eq(toolCalls.runId, run.id));
  const [evaluation] = await database
    .select()
    .from(evaluationRuns)
    .where(eq(evaluationRuns.subjectRunId, run.id))
    .limit(1);

  console.info(
    JSON.stringify(
      {
        target,
        observationId: observed.observationId,
        conversationId: observed.conversationId,
        run: { id: run.id, status: run.status, error: run.error },
        tools: calls.map(({ toolName, outcome, output, error }) => ({
          toolName,
          outcome,
          output,
          error,
        })),
        evaluationId: evaluation?.id,
      },
      null,
      2,
    ),
  );
  if (run.status !== "succeeded") throw new Error(run.error ?? "Conversation run failed");
} finally {
  await resources.whatsapp.dispose().catch(() => {});
  await resources.database.close().catch(() => {});
  client.close();
}
