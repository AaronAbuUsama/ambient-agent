import { and, asc, eq } from "drizzle-orm";
import type { AgentTodo, AgentTodoStore } from "../conversation/contract";
import type { AmbientDatabaseConnection } from "./database";
import { agentTodos } from "./schema";

export function createAgentTodoStore(database: AmbientDatabaseConnection): AgentTodoStore {
  return {
    async open(conversationId) {
      const rows = await database
        .select()
        .from(agentTodos)
        .where(and(eq(agentTodos.conversationId, conversationId), eq(agentTodos.status, "open")))
        .orderBy(asc(agentTodos.createdAt));
      return rows.map(({ id, note, createdAt }): AgentTodo => ({ id, note, createdAt }));
    },

    async add({ conversationId, note }) {
      const id = crypto.randomUUID();
      await database.insert(agentTodos).values({
        id,
        conversationId,
        note,
        status: "open",
        createdAt: new Date().toISOString(),
      });
      return { id, note, createdAt: new Date().toISOString() };
    },

    async settle({ conversationId, id, status, outcome }) {
      const [updated] = await database
        .update(agentTodos)
        .set({
          status,
          settledAt: new Date().toISOString(),
          ...(outcome === undefined ? {} : { outcome }),
        })
        // Scoped to the conversation: one chat's speaker must not close
        // another chat's intention by naming its id.
        .where(
          and(
            eq(agentTodos.id, id),
            eq(agentTodos.conversationId, conversationId),
            eq(agentTodos.status, "open"),
          ),
        )
        .returning({ id: agentTodos.id });
      return updated !== undefined;
    },
  };
}
