# Architecture Decision Records

Every load-bearing decision lives here as a numbered ADR. The point of an ADR is to capture the decision, the alternatives considered, and the trade-offs, so a future contributor (or AI agent) can re-read the reasoning instead of re-deriving it.

## When to write one

Anything that changes:

- The data model (new tables, schema migrations)
- The security floor (any change to `docs/SECURITY.md`)
- The pricing model
- The value proposition (what's in `docs/VISION.md`)
- Choice of a major dependency, runtime, or external service

## Format

One file per decision. Numbered sequentially. Markdown. Use the template below.

```
# NNNN — Short title

Status: Proposed | Accepted | Superseded by NNNN
Date: YYYY-MM-DD

## Context

What is the situation? What problem are we solving?

## Decision

What did we decide? Be specific.

## Alternatives considered

What did we look at and reject? Why?

## Consequences

What does this make easier? Harder? What follow-on work does it imply?
```

## Existing ADRs

- [0001 — Stack: Electron + pnpm monorepo](0001-stack.md)
- [0002 — Schema reconciliation: align 0001 with ARCHITECTURE](0002-schema-reconciliation.md)
