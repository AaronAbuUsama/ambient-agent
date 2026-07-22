# Digest push stores seed selection and recomputes one live projection

Mechanical pull and deliberate Brain push remain one `graphContext`. For a Directive, the
Brain may select at most eight additional Belief Projection entity ids. The Directive stores
only that selection. At delivery, trusted code runs the existing projector over local pull
plus selected seeds in one Projection version and returns one stable-key union.

The context records schema and Projection versions, generation time, pull/push seeds,
supporting Attestation ids, and deterministic truncation. Initial hard maxima are 64 entities,
128 relations, 32 open commitments, eight supporting Attestations per item, and 64 KiB JSON.
Arbitrary traversal depth and unrestricted dumps are not supported.

The computed Digest is ephemeral and recomputed after restart. A Directive's Brief separately
preserves the causal source evidence behind the decision; current Digest memory may legitimately
change before delivery. Ordinary pull remains best effort, while a requested deliberate push
is never silently omitted from an authoritative Directive.

## Rejected

- Persisted pushed-Digest snapshots or caches.
- A second context field, inbox, or projector.
- Model-authored Graph rows, provenance, or traversal policy.
- Push overwriting pull instead of a deterministic union.
