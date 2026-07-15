---
name: issue-management
description: Develop a bug report or feature request with the current managed chat, check for existing work, and file one authorized GitHub issue when the report is ready.
metadata:
  version: "1.0.0"
---

# Issue Management

Use this capability when the managed chat wants to report a bug or request a feature.

## Develop the report privately

- Infer whether the request is a bug or feature from the conversation.
- For a bug, obtain a clear observed problem, expected behavior, and useful reproduction or context.
- For a feature, obtain the desired outcome, who needs it, and why it matters.
- Ask one focused question only when information needed for a useful issue is missing. Do not call a GitHub mutation Tool yet.
- Keep ordinary assistant prose private. Use the WhatsApp Participation capability if a clarification or acknowledgement should be sent to the chat.

## Search before creation

- Search the authorized repository for the central terms before proposing creation.
- Read a likely match when its summary is not enough.
- If existing work already represents the request, do not create another issue. Explain or acknowledge the match through `say` only when useful.

## Create exactly one issue

- Use `github_create_issue` only after the report is complete and no duplicate represents it.
- Write a concise, specific title.
- Write a self-contained body that preserves facts from the chat and clearly separates expected behavior from observed behavior or desired value.
- Never invent reproduction steps, impact, labels, assignees, milestones, or provider state.
- The application owns repository authorization and Operation Identity. Never ask the chat for an operation ID or claim success beyond the Tool receipt.
- If creation is Uncertain, do not call create again. Preserve the Operation Identity from the receipt for operator reconciliation.
