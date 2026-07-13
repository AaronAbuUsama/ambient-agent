import type { ConversationWindow } from "../coalescer/events.ts";
import {
  gitHubProofCompletedSchema,
  gitHubProofUncertainSchema,
  repositoryRefSchema,
} from "../github/proof-contract.ts";
import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const whatsappWindowInputSchema = v.object({
  type: v.literal("whatsapp.window"),
  chatId: nonEmptyString,
  reason: v.union([v.literal("debounce"), v.literal("mention"), v.literal("quote-reply")]),
  messages: v.array(
    v.object({
      id: nonEmptyString,
      chatId: nonEmptyString,
      from: nonEmptyString,
      pushName: v.optional(v.string()),
      text: v.string(),
      timestamp: v.pipe(v.number(), v.finite()),
      isGroup: v.boolean(),
      fromMe: v.boolean(),
      live: v.boolean(),
      mentions: v.array(nonEmptyString),
      quotedFrom: v.optional(nonEmptyString),
    }),
  ),
});

export type WhatsAppWindowInput = v.InferOutput<typeof whatsappWindowInputSchema>;

export const workflowCompletedInputSchema = v.object({
  type: v.literal("workflow.completed"),
  chatId: nonEmptyString,
  workflow: nonEmptyString,
  runId: nonEmptyString,
  operationId: nonEmptyString,
  output: gitHubProofCompletedSchema,
});

export const workflowUncertainInputSchema = v.object({
  type: v.literal("workflow.uncertain"),
  chatId: nonEmptyString,
  workflow: nonEmptyString,
  runId: nonEmptyString,
  operationId: nonEmptyString,
  output: gitHubProofUncertainSchema,
});

export const workflowFailedInputSchema = v.object({
  type: v.literal("workflow.failed"),
  chatId: nonEmptyString,
  workflow: nonEmptyString,
  runId: nonEmptyString,
  operationId: nonEmptyString,
  repository: repositoryRefSchema,
  error: v.object({ message: nonEmptyString }),
});

export type WorkflowCompletedInput = v.InferOutput<typeof workflowCompletedInputSchema>;
export type WorkflowUncertainInput = v.InferOutput<typeof workflowUncertainInputSchema>;
export type WorkflowFailedInput = v.InferOutput<typeof workflowFailedInputSchema>;
export type AmbienceInput =
  | WhatsAppWindowInput
  | WorkflowCompletedInput
  | WorkflowUncertainInput
  | WorkflowFailedInput;

export const whatsappWindowInput = (window: ConversationWindow): WhatsAppWindowInput =>
  v.parse(whatsappWindowInputSchema, {
    type: "whatsapp.window",
    chatId: window.chatId,
    reason: window.reason,
    messages: window.messages,
  });
