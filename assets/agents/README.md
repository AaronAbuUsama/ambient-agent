# Agent portrait pack

Candidate display pictures and fictional persona profiles for the Ambient Agent team. These are repository assets only: adding them here does not configure GitHub Apps, WhatsApp identities, or runtime agent names.

The pack lives under `assets/agents/` because these portraits represent agent identities. Product-level logos, banners, and the default Ambient Agent display picture remain under `assets/brand/`.

## Portraits

| Portrait                                         | Persona                       | Intended product role                                                          |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------ |
| ![Malik Ward](./01-malik-ward-captain.png)       | **Malik Ward — Captain**      | Speaker / primary WhatsApp-facing team lead                                    |
| ![Idris Okafor](./02-idris-okafor-architect.png) | **Idris Okafor — Architect**  | Planner                                                                        |
| ![Theo Park](./03-theo-park-coder.png)           | **Theo Park — Coder**         | Coder GitHub App                                                               |
| ![Rafael Iqbal](./04-rafael-iqbal-reviewer.png)  | **Rafael Iqbal — Reviewer**   | Reviewer GitHub App                                                            |
| ![Gareth Pike](./05-gareth-pike-code-viewer.png) | **Gareth Pike — Code Viewer** | Additional deep-code specialist concept; not currently a ratified runtime role |

All portraits are 1254 × 1254 RGB PNGs with centered subjects and safe space for circular display-picture cropping.

## Runtime boundary

The current ratified identity design recommends distinct avatars for three GitHub Apps: Coder, Reviewer, and Planner. The Speaker shares the Planner App for inline planning actions, while the Scribe has no GitHub identity. See the [memory and state specification](../../docs/planning/MEMORY-STATE-SPEC.md#7-identity-model-135-grounded-in-the-mechanics-134).

Use this directory as the visual source pack. Keep runtime names, credentials, and identity configuration in their existing configuration paths rather than encoding them into these files.

## Supporting material

- [Persona backstories and team dynamics](./team-profiles.md)
- [Export manifest and checksums](./manifest.md)
