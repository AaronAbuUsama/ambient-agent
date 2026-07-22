---
name: verify
description: Behavior-verify the ambient-agent runtime end-to-end on the live rig. Thin entry point — the full live rig map, deploy recipe, and proof discipline live in the rig skill.
---

# Verify (alias)

Read and follow [.claude/skills/rig/SKILL.md](../rig/SKILL.md) — it holds the live rig
map (capxul-vps), the build → deploy recipe, the nonce + correlated-receipts + restart
proof discipline, and the scenario library. Verification here means **runtime observation
of the real product** (WhatsApp → Brain → GitHub with receipts), never unit tests alone.
This file exists so verifier sessions that look for a `verify` skill land on the current
protocol.
