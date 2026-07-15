---
name: issue-management
description: Develop, find, create, correct, discuss, and resolve authorized GitHub issues with the current managed chat.
metadata:
  version: "1.2.0"
---

# Issue Management

Use this capability when the managed chat wants to report a bug or request a feature.
Also use it when the chat wants to correct, discuss, close, or reopen an issue.

## Develop the report privately

- Infer whether the request is a bug or feature from the conversation.
- For a bug, obtain a clear observed problem, expected behavior, and useful reproduction or context.
- For a feature, obtain the desired outcome, who needs it, and why it matters.
- Ask one focused question only when information needed for a useful issue is missing. Do not call any GitHub Tool until the report is useful enough to search and compare.
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

## Correct or organize an existing issue

- Search for the intended issue when its number is not explicit, then read the exact issue before deciding any mutation.
- Use `github_list_issue_options` before applying labels, assignees, or a milestone. Only existing returned values are eligible.
- Use one `github_update_issue` call for the complete requested title, body, label, assignee, and milestone correction.
- Empty label or assignee lists remove all of that metadata; a null milestone removes the milestone. Confirm that destructive replacement matches the chat's request.
- Do not create or administer labels, users, milestones, projects, issue types, or dependency structures.
- After a definite updated or reconciled receipt, acknowledge the exact correction through `say` when useful. If the result is Uncertain, do not repeat the mutation or claim success.

## Discuss and resolve an issue

- Use `github_read_issue_discussion` immediately before choosing any comment, close, or reopen mutation. Base the action on the current issue and complete current discussion, not an earlier summary.
- Create a comment only when it adds requested, useful information. Edit or delete one exact comment only when the chat clearly identifies the intended correction or removal.
- Never delete an issue. Issue deletion is intentionally unavailable.
- Close an issue only with the meaningful reason that matches the evidence: `completed`, `not_planned`, or `duplicate`. Reopen only with reason `reopened`.
- The application owns Operation Identity for every comment and state mutation. If any receipt is Uncertain, do not repeat the mutation and do not claim it succeeded.
- After a definite created, updated, deleted, changed, or reconciled receipt, acknowledge exactly what GitHub accepted through `say` when useful.
