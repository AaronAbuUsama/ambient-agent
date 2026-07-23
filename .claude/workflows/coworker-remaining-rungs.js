export const meta = {
  name: 'coworker-remaining-rungs',
  description: 'Brief, build, review, and merge the six remaining coworker construction rungs on integration/coworker-replacement',
  phases: [
    { title: 'Brief', detail: 'parallel read-only implementation briefs per rung' },
    { title: 'Build', detail: 'serial construction PRs with cold review pairs' },
    { title: 'Audit', detail: 'completeness critic over the merged result' },
  ],
}

const REPO_DIR = '/Users/abuusama/projects/ambient-agent'
const CANON = `Canon (read before anything): docs/SYSTEM-ARCHITECTURE.md (esp. §4, §5, §7, §13), STATUS.md, AGENTS.md, and execution issue #299 on github.com/AaronAbuUsama/ambient-agent. All work targets branch integration/coworker-replacement. Vocabulary: Brain, Speaker, Intent, Brain Batch, Brain Effect, Directive, Surface, Attestation, Belief Projection — use these words exactly; never invent a new domain noun without a code path that branches on it.`

const RUNGS = [
  {
    key: 'multi-org',
    issue: null,
    title: 'Multi-org GitHub App installation resolution',
    brief_focus: `packages/installation/src/github-app-client.ts mints installation tokens from the single installationId stored in credentials/github-{coder,planner,reviewer}.json. Aaron is installing the three public Apps on orgs Xelmar-tech and TheCallApp. Design per-repo installation resolution: resolve the installation for a repository via GET /repos/{owner}/{repo}/installation using the App JWT, cache per owner, fall back to the stored installationId for the home account. Cover: config allowedRepositories accepting org repos, config --repository verification path, and every call site that assumes the fixed id. Keep the credential file schema backward compatible.`,
  },
  {
    key: 'file-issue',
    issue: 317,
    title: 'Brain file_issue effect + Speaker issue-shape elicitation + honest closure (#317)',
    brief_focus: `Read #317 and #319 on GitHub. Three parts: (1) a new Brain effect file_issue in the validated effect algebra (alongside prompt_speaker/stay_silent/start_coder_job) that files via the existing github_issue_operations store under the planner identity — a deterministic provider mutation, NOT a Bounded Workflow — with durable operation identity and retry idempotence; (2) Speaker-side issue-shape elicitation: the whatsapp-participation capability already ratifies elicitation as task-workflow speech — add the issue-shape checklist (bug: what happened/expected/where/repro; feature: problem/desired/scope) so the Speaker gathers a complete request BEFORE escalating one well-formed Intent; (3) honest closure: an Intent the Brain cannot fulfil MUST produce a prompt_speaker with an honest cannot-do — an acked request is never left silent. Repo targeting: the Brain needs the Surface→Repository mapping to pick the repo; the simplest honest v1 is a per-managed-chat default repository in config plus Brain judgment, with the Graph relation as the designed follow-up.`,
  },
  {
    key: 'reviewer-dispatch',
    issue: 318,
    title: 'Brain start_reviewer_job work mode (#318)',
    brief_focus: `Read #318. Clone the #308 seam: the Brain mounts start_coder_job with a durable brain-work record, Flue admission reconciliation, and terminal-result intake (packages/agents/src/brain, brain_specialist_launches/results). Add start_reviewer_job dispatching the existing Reviewer Specialist workflow against a PR number + repository, same durable launch/result lifecycle, result returns to the Brain which reports via prompt_speaker.`,
  },
  {
    key: 'ingress-upinbox',
    issue: 254,
    title: 'GitHub webhooks into the Brain up-inbox, replacing broadcast/drop (#254 T5a)',
    brief_focus: `Read #254 including the 2026-07-23 comment: transport is fixed (App hook → https://ambient-agent.abuusama.dev/channels/github/webhook → capxul tunnel → runtime :3737) and deliveries now reach the runtime but get 401 at signature/channel validation with nothing in the operator journal. First diagnose the 401 (App hook secret vs the runtime webhook secret in the planner credential vs the Flue github channel expectations — apps/runtime/src/host/bridge-route.ts, packages/engine/src/github/ingress-runtime.ts). Then the real slice: verified deliveries become durable Brain up-inbox inputs (brain_inbox_inputs) instead of the legacy broadcast-to-every-Speaker path (installGitHubIngressRuntime dispatch-to-chat); uncorrelated events land with the Brain, never dropped; the legacy broadcast path is deleted per #299 slice 4.`,
  },
  {
    key: 'refine-rekick',
    issue: 211,
    title: 'Brain re-kicks the Coder on review feedback (#211)',
    brief_focus: `Read #211 and SYSTEM-ARCHITECTURE §7. With #254 landed, a changes-requested review or review-comment webhook reaches the Brain up-inbox. Add the refinement decision: Brain launches a coder job in a refine mode against the existing PR/branch (the coder workflow already updates existing PRs — see PR #162 update on 2026-07-22; formalize refine_pull_request input per the ratified T5 #286 decision: fresh Bounded Workflow run reconstructed from provider truth, never resumed). Guard against loops: one refinement launch per review event identity, retry-idempotent.`,
  },
  {
    key: 'downflow-awareness',
    issue: 319,
    title: 'Down-flow work-state awareness: milestones → Brain → digest; check tool; work-start preamble (#319)',
    brief_focus: `Read #319 — it is the ratified contract. Parts: (1) workflow progress milestones (start/terminal at minimum) admitted durably to the Brain; (2) extend the graphContext digest projection with active work items + latest milestone so every Speaker turn carries current work state as knowledge (packages/engine graph/digest seams; §5.4 one-channel rule — no second context mechanism); (3) a Speaker tool to query the Brain's open loops for detail; (4) Speaker guidance: when the digest shows work just launched for this Surface, say a short natural work-started line, and always narrate outcomes. Speaking stays the mouth's judgment per the participation rubric; knowing is mandatory.`,
  },
]

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['rung', 'seams', 'design', 'tests', 'risks', 'out_of_scope'],
  properties: {
    rung: { type: 'string' },
    seams: { type: 'array', items: { type: 'string' }, description: 'exact file:line anchors of every seam the change touches' },
    design: { type: 'string', description: 'the implementation plan grounded in those seams, with exact type/table/tool names' },
    tests: { type: 'array', items: { type: 'string' }, description: 'the focused unit/integration/structural checks to add or extend' },
    risks: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' }, description: 'what this rung deliberately does NOT claim' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'fix'] },
    findings: { type: 'array', items: { type: 'string' } },
  },
}

const RESULT_SCHEMA = {
  type: 'object',
  required: ['status', 'pr', 'summary'],
  properties: {
    status: { type: 'string', enum: ['merged', 'pr-open-unmerged', 'blocked'] },
    pr: { type: 'number' },
    summary: { type: 'string' },
    honest_boundary: { type: 'string' },
  },
}

phase('Brief')
log('Fanning out read-only implementation briefs for all six rungs')
const briefs = await parallel(RUNGS.map((r) => () =>
  agent(
    `${CANON}\n\nYou are producing a read-only IMPLEMENTATION BRIEF — no edits, no branches. Repo: ${REPO_DIR} (use git show origin/integration/coworker-replacement:<path> to read branch state; gh for issues). Rung: ${r.title}.\n\n${r.brief_focus}\n\nGround every claim in file:line on the integration branch. The brief must be executable by a fresh agent that has never seen this conversation. Name the smallest honest test set and the exact proof the PR can claim mechanically (live TST proof is out of scope — it happens after deploy).`,
    { label: `brief:${r.key}`, phase: 'Brief', schema: BRIEF_SCHEMA, model: 'opus', effort: 'medium' },
  ),
))

const briefByKey = {}
RUNGS.forEach((r, i) => { briefByKey[r.key] = briefs[i] })

phase('Build')
const results = []
for (const r of RUNGS) {
  const b = briefByKey[r.key]
  if (!b) { results.push({ status: 'blocked', pr: 0, summary: `${r.key}: brief failed` }); continue }
  log(`Building rung: ${r.title}`)
  const build = await agent(
    `${CANON}\n\nYou are the construction agent for one rung: ${r.title}. Work in your isolated worktree copy of ${REPO_DIR}.\n\nBRIEF (follow it; deviate only when the code contradicts it, and say so):\n${JSON.stringify(b, null, 1)}\n\nProcedure — follow exactly:\n1. git fetch origin && git checkout -b claude/rung-${r.key} origin/integration/coworker-replacement (always the LATEST tip — earlier rungs may have merged).\n2. pnpm install. Implement the brief. Match surrounding style; comments only for constraints code cannot show.\n3. pnpm run typecheck && pnpm run build:runtime && the focused tests from the brief plus pnpm test. All green before any push.\n4. Commit, push, open a PR with gh: base integration/coworker-replacement, body states the EXACT claim at this tip and the honest boundary (what it does NOT claim — live proof is deferred to the rig). ${r.issue ? `Reference #${r.issue}.` : ''}\n5. Wait for CI with gh pr checks --watch. If CI fails, fix and push (max 2 fix rounds, then report blocked).\n6. Do NOT merge. Return the PR number, the claim, and the honest boundary.\nReturn raw JSON only.`,
    { label: `build:${r.key}`, phase: 'Build', schema: RESULT_SCHEMA, isolation: 'worktree', model: 'opus', effort: 'medium' },
  )
  if (!build || build.status === 'blocked' || !build.pr) {
    results.push(build ?? { status: 'blocked', pr: 0, summary: `${r.key}: build agent died` })
    log(`Rung ${r.key} blocked — continuing to next rung without it`)
    continue
  }
  log(`Rung ${r.key}: PR #${build.pr} open — dispatching cold review pair`)
  const reviews = await parallel(['correctness-and-durability', 'spec-and-architecture-fit'].map((lens) => () =>
    agent(
      `${CANON}\n\nCold review of PR #${build.pr} in AaronAbuUsama/ambient-agent through the ${lens} lens. You have NO prior context — that is deliberate. Read the PR diff (gh pr diff ${build.pr}), the PR body's claim, ${r.issue ? `issue #${r.issue}, ` : ''}and only the surrounding code you need (repo at ${REPO_DIR}, branch state via git show). ${lens === 'correctness-and-durability' ? 'Hunt real defects: crash-gap and restart holes, retry non-idempotence, silent drops, race conditions, dishonest receipts.' : 'Verify the diff matches the issue contract and #299/SYSTEM-ARCHITECTURE invariants: no new domain nouns without code paths, no second context mechanism, no Speaker authority creep, honest boundary stated.'} Report findings only if they are real and actionable — verdict fix requires at least one concrete defect with file:line.`,
      { label: `review:${r.key}:${lens}`, phase: 'Build', schema: VERDICT_SCHEMA, model: 'fable' },
    ),
  ))
  const fixes = reviews.filter(Boolean).flatMap((v) => (v.verdict === 'fix' ? v.findings : []))
  if (fixes.length > 0) {
    log(`Rung ${r.key}: ${fixes.length} review findings — one fix round`)
    await agent(
      `${CANON}\n\nYou are fixing review findings on PR #${build.pr} (branch claude/rung-${r.key}) in your isolated worktree of ${REPO_DIR}. ONE round only — this is the hard cycle cap.\nFindings:\n${fixes.map((f) => `- ${f}`).join('\n')}\n\ngit fetch origin && git checkout claude/rung-${r.key} && pnpm install. Address every finding or reply on the PR why a finding is wrong. typecheck + tests green, push, wait for CI green (gh pr checks --watch). Return raw JSON.`,
      { label: `fix:${r.key}`, phase: 'Build', schema: RESULT_SCHEMA, isolation: 'worktree', model: 'opus', effort: 'medium' },
    )
  }
  const merged = await agent(
    `Repo ${REPO_DIR}. Verify PR #${build.pr} (AaronAbuUsama/ambient-agent) has CI green on its latest commit (gh pr checks ${build.pr}); if green, merge it with gh pr merge ${build.pr} --merge and confirm the new tip of integration/coworker-replacement contains it. If CI is red or the merge conflicts, do NOT force anything — report blocked with the reason. Return raw JSON.`,
    { label: `merge:${r.key}`, phase: 'Build', schema: RESULT_SCHEMA, model: 'haiku', effort: 'low' },
  )
  results.push({ ...(merged ?? build), pr: build.pr, rung: r.key })
}

phase('Audit')
const audit = await agent(
  `${CANON}\n\nCompleteness critic. Rung results:\n${JSON.stringify(results, null, 1)}\n\nAgainst repo ${REPO_DIR} (fetch first) and issues #317 #318 #254 #211 #319 #299: verify each merged PR is really on integration/coworker-replacement with CI green; verify claims match diffs; list every remaining gap (unmerged rungs, review findings skipped, issue acceptance criteria untouched, legacy paths not deleted); list exactly which live TST proofs the rig session must now run per rung. Comment a concise status update on issue #299 via gh (integration progress: which rungs merged, which blocked, honest boundaries). Return a markdown report.`,
  { label: 'audit', phase: 'Audit', model: 'fable' },
)

return { results, audit }