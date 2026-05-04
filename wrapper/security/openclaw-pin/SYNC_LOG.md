# OpenClaw upstream sync log

Append-only log of upstream pin bumps. Each entry records the SHA we synced
to, the date, the diff summary, and the human reviewer's sign-off.

The first entry below establishes the baseline pin from Phase 2g.

---

## 2026-04-29 — initial pin

- **From:** N/A (initial pin)
- **To:** `1ffe8fde84d1c558a23d3ae985800c7bcfaf06a6`
- **Reviewer:** Matt
- **Diff summary:** N/A — establishing baseline. Subsequent bumps will include
  a `git diff --stat` summary scoped to `openclawPaths`.
- **Notes:** Baseline pin established as part of Phase 2g (Security Overhaul
  workstream). The pin is `1ffe8fde84` ("fix: stabilize docker test suite",
  Peter Steinberger, 2026-03-17), the actual `git merge-base` between our
  HEAD and `openclaw-upstream/main`. The Phase 2g prompt suggested
  `85781353e` (the SHA Phase 2a verified hook contracts against), but that
  is two commits behind our true fork point, and using it would have flagged
  two clean upstream commits as drift. Phase 2a's hook-contract reference
  remains a code-reading anchor; the sync pin is what we last absorbed.

  Local modifications to OpenClaw-owned paths captured in
  `PATHS.json#localModsPaths`. They are not enforced byte-for-byte; their
  drift is reviewed manually at each sync.

  Upstream tags are SSH-signed (Peter Steinberger, ed25519). Verification
  requires configuring `gpg.ssh.allowedSignersFile` with the maintainer's
  public key — filed as a post-launch follow-up; not enforced by this
  baseline.
