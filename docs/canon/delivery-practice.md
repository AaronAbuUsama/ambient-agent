# Ambient Delivery Practice

Status: active working practice.

Ambient has a stable product direction and substantial implementation
uncertainty. We will not attempt to remove that uncertainty by writing one large
specification and then building it mechanically. We will preserve stable
invariants, learn through small vertical slices, and revise mechanisms when
evidence changes our understanding.

## Core rule

> Define invariants globally, discover mechanisms locally, and promote a pattern
> into shared architecture only after more than one real slice proves it is
> shared.

The product model is a north star, not a mandate to create every concept as a
generic table, interface, or framework before it is needed.

## Three planning horizons

### 1. Product principles

[`product-model.md`](./product-model.md) owns relatively stable truths:

- what kind of entity Ambient is;
- the fixed agent kinds and their qualitative differences;
- how identity, situated conversation, memory, delegation, and autonomy fit
  together;
- which concepts must remain distinct;
- settled principles and open product questions.

These principles should change only when product evidence shows they are wrong.

### 2. Architectural decisions

Use a short decision record only for a consequential choice that:

- is expensive to reverse;
- affects several modules or future slices;
- resolves a genuine contested alternative;
- establishes an invariant callers will depend on.

A decision record should be concise:

```text
Context
Decision
Why
Alternatives rejected
Consequences
What remains open
Evidence or proof
```

Do not create decision records for private helpers, naming choices, or other
easily reversible implementation details.

If decision records become necessary, place them under `docs/decisions/` and
number them sequentially. Do not create that directory before the first real
decision earns it.

### 3. Slice briefs

Plan only one active implementation slice in detail. A slice brief should
normally fit on one page and state:

1. **Product question**: what uncertainty or capability is this slice testing?
2. **Concrete journey**: one end-to-end scenario.
3. **Owner**: which deep module owns the behaviour?
4. **Durable protocol**: records, handoffs, and state-transition owners.
5. **Smallest API**: the minimum public surface required.
6. **Preserved invariants**: what proven behaviour must not regress?
7. **Non-goals**: what tempting adjacent work is explicitly excluded?
8. **Proof gate**: deterministic and, where justified, controlled live evidence.
9. **Open questions**: what this slice deliberately does not resolve.

Keep the active brief in
[`../status/current-state.md`](../status/current-state.md), or link from there
to a separate brief only when one page is genuinely insufficient.

## Classifying uncertainty

Every important unknown should be classified before work begins.

### Decide now: invariants

Decide matters that protect product integrity or would be costly to reverse:

- the Root does not casually bypass Conversation Agents;
- external effects require durable evidence;
- Conversation terminal responses are private;
- durable work survives process and model failure;
- agents coordinate through inspectable durable handoffs;
- audience and disclosure boundaries are explicit;
- third-party framework types stop at adapters;
- one durable transition has one authoritative mutation path.

### Spike before deciding: expensive unknowns

Use a short, disposable investigation when a wrong assumption would distort the
architecture:

- dynamic MCP tool composition;
- provider-specific tool-call behaviour;
- Root context requirements;
- WhatsApp identity or group limitations;
- model protocol compatibility.

A spike has:

- a time or scope boundary;
- no obligation to become production code;
- one explicit question;
- a recorded result and recommendation.

Its output is evidence, not scaffolding.

### Learn by building: reversible details

Do not block a slice while perfecting choices that can be changed locally:

- private function organization;
- prompt formatting;
- initial debounce values;
- internal names;
- whether a private implementation begins as a function or class.

### Deliberately defer: unsupported policy

Record but do not pre-build policies for which there is not yet product
evidence:

- the complete Root attention policy;
- a general permission language;
- recursive agent hierarchies;
- the final reusable Worker-definition lifecycle;
- a universal event system;
- arbitrary channel parity.

Deferral is an explicit decision, not forgotten work.

## Two delivery tracks

### Architecture rescue

Rescue preserves proven behaviour while replacing shallow or leaky boundaries.
It should not introduce major new product capability at the same time. The
current rescue candidates and selected cut belong in
[`../status/current-state.md`](../status/current-state.md), not in canon.

### Product discovery

Discovery slices test the product model through real journeys. Current themes
belong in [`../status/current-state.md`](../status/current-state.md), while
settled journeys and open product questions remain in
[`product-model.md`](./product-model.md).

Alternate rescue and discovery when practical. Do not combine a broad rewrite
with a major autonomous feature.

## The slice loop

Every slice follows the same loop:

```text
frame one product question
  -> write the smallest brief
  -> inspect current code and invariants
  -> implement one vertical path
  -> prove deterministic behaviour
  -> run a controlled live proof when justified
  -> review module depth and duplication
  -> update the current-state ledger
  -> decide the next slice
```

### Before implementation

- Name the owning module.
- Identify the durable records and state-transition owners.
- Draw the dependency direction.
- Identify third-party details that will be hidden.
- State restart, retry, duplication, and partial-failure behaviour.
- Search for existing user work and proven invariants that must be preserved.

### During implementation

- Build the thinnest complete path, not horizontal scaffolding.
- Keep exactly one authoritative mutation path per durable aggregate.
- Treat callbacks and timers as wake hints, never durable truth.
- Prefer explicit role or kind semantics over generic frameworks.
- Keep configuration data separate from executable adapters and secret values.
- Do not implement future roles merely to make current abstractions look
  symmetrical.

### Proof gate

A slice is not complete because it compiles.

Use the narrowest relevant evidence:

1. focused unit or contract tests;
2. restart, retry, deduplication, and failure tests for durable behaviour;
3. full static and repository validation;
4. a guarded live proof only when it establishes something simulation cannot;
5. retained evidence proving any external effect.

Never use a live proof as a substitute for deterministic tests.

### Review point

After proof, stop before beginning the next slice and ask:

- Did this produce a deep module or another forwarding layer?
- Can the journey be explained without reconstructing mechanisms?
- Did policy become duplicated?
- Did a current abstraction earn reuse, or is it still specific to one slice?
- Which open question now has evidence?
- What should be removed or simplified?

The next slice is selected after this review, not committed months in advance.

## Promotion rule

Do not generalize from one example unless the shared invariant is already
fundamental to the product.

A pattern normally earns promotion into shared architecture when:

1. at least two real slices require it;
2. the shared semantics are stable and clearly named;
3. sharing removes more concepts than it introduces;
4. callers become less aware of implementation detail;
5. the abstraction can enforce a meaningful invariant.

Examples:

- Root, Conversation, Worker, and Memory kinds are product-level distinctions
  and may be designed explicitly from the outset.
- A generic assignment table should wait until Conversation and Worker
  assignments demonstrate truly shared lifecycle semantics.
- A generic capability policy language should wait until explicit capability
  bundles fail more than one real use case.

## Keeping plans honest

Maintain three scopes in
[`../status/current-state.md`](../status/current-state.md):

- **Active slice**: detailed enough to implement now.
- **Likely next slice**: named with a short reason, not fully designed.
- **Themes**: unordered future product questions.

Never label distant themes as committed phases.

When evidence invalidates a plan:

1. stop implementation;
2. record what was learned;
3. preserve or revert proven behaviour safely;
4. update the product model only if a product principle changed;
5. update the current-state ledger;
6. write a decision record only if a consequential architectural choice was
   made.

Changing the plan in response to evidence is expected. Hiding the change behind
incremental patches is not.

## Documentation hygiene

- `AGENTS.md` contains the non-negotiable engineering contract.
- `canon/product-model.md` defines the product ontology.
- `canon/architecture.md` defines module and protocol ownership.
- `canon/delivery-practice.md` defines this working method.
- `status/current-state.md` records the active ledger and brief.
- `maps/` contains derived visualizations.
- Superseded plans and maps move to `archive/`.

Do not duplicate whole sections between documents. Link to the owning document.
Archive obsolete material instead of leaving contradictory current guidance in
place.
