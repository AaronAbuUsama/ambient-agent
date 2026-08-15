# Media interpretation: describe once, keyed by content hash

Retained media becomes text through a deterministic interpreter that resolves
the bytes, asks a vision model once per unique blob, and retains the answer.
Every role reads that text; no role reads bytes.

## The problem, measured

The Bug Reports group carries 14 images and 4 videos, and 17 of the 18 have a
caption. The caption tells you a bug exists; the pixels are the report. On
1 August the reporter sent five screenshots captioned "Fajr time android",
"Fajr time Muslim Pro", "Fajr time Google", "Fajr time Pillars", "Fajr time
ios" — the entire evidentiary content is in the images. Ambient held all five
and could read none of them.

Measured on those exact retained blobs: the Android screenshot shows Fajr
03:39, the iOS one shows Fajr 02:46. That 53-minute gap is the defect the
group spent two weeks arguing about, and it was sitting in the media store the
whole time.

Three walls stood between the bytes and a reader. Live ingestion discarded
every non-text message, so only history-sync sweeps retained anything. The
retained-read schema typed only the caption, so the store ref was invisible.
And nothing in the application could turn a ref back into bytes at all, though
the dependency exposes the API and the store was already constructed.

## Decision

A description is **evidence**, so it is retained before the next role runs —
not conjured inside a prompt. The interpreter owns the vision call, the
retention, and the refusal to interpret what it cannot.

The media store's content hash is the idempotency key. The same image
forwarded into ten chats is described once, ever; re-digesting a window costs
nothing. Failures are retained too, so an unreadable blob is not retried
forever.

Interpretation runs on the memory path, not only the conversation path. A
listening chat never runs a speaker, and the group this was built for is
listening-only — describing media only where a speaker runs would have left
every screenshot in it unread.

Modality is declared per model in configuration and fails closed. The harness
replaces images with a placeholder string on a text-only model, silently, so
an undeclared model must be treated as blind: the interpreter refuses to
construct rather than produce confident descriptions of nothing.

## Alternatives rejected

**Inline vision at digestion.** Attach images to the memory window prompt and
let the analyst look. Simpler, and wrong in the way that matters: the evidence
lives only inside one prompt, is paid for again on every re-digest, and a
judge — which is text-only — cannot check a claim grounded on something it
cannot see.

**On-demand only.** A `view_image` tool and nothing proactive. The model has to
know to look, and in a listening chat nothing is looking at all. Kept as the
_second_ half rather than the whole: it covers older images nobody described,
and its scoping is the host's, since a ref names a blob in a store every chat
shares.

**Caption-only (the status quo).** Free and blind. It is what produced an
ontology that knows five screenshots were sent and nothing about what they
showed.

**Video interpretation.** Deferred. Frames prove which screen, not what went
wrong, and the clips here show behaviour over time ("the swipe is still a bit
dodgy"). Video is retained and can be attached to a report; attaching is not
understanding, and the honest move is to say so and ask.

## Consequence worth naming

Issue attachments depend on an endpoint GitHub does not document —
`uploads.github.com/user-attachments/assets`, the one its own web client uses.
It accepts a `gh` token and was verified end to end: 201 with an asset URL,
which GitHub rewrites into a signed asset when it renders the body, for images
and video alike. It can vanish without notice. The failure is visible rather
than silent — a filed issue reports fewer embedded attachments than it was
given, and says so in its body — and the supported fallback is a release asset
per repository.
