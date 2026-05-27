# 0002 — Schema reconciliation: align 0001_initial.sql with ARCHITECTURE.md

Status: Accepted
Date: 2026-05-26

## Context

The initial migration (0001_initial.sql) was seeded from the skeleton but was behind the data model documented in ARCHITECTURE.md. Since nothing has shipped and no user databases exist, we can amend 0001 in place rather than adding a separate migration.

## Decision

Extend 0001_initial.sql to include all tables and columns specified in ARCHITECTURE.md:

1. Add `instructions_md` (nullable TEXT) to `workspaces` and `projects`. These are the prose policy layer of the two-layer control model documented in ARCHITECTURE.
2. Add `commitments` table with all columns from ARCHITECTURE: trigger_type, trigger_spec, next_fire_at, action_template, reversibility, autonomy, status, done_condition, missed_run_policy, last_run_at. Index on next_fire_at for the scheduler.
3. Add `commitment_runs` table: commitment_id, started_at, finished_at, outcome, detail.
4. Add to `app_state`: model_provider, model_api_key_keychain_ref (for onboarding model-key capture), personality_mode, autonomy_default, missed_run_default, openclaw_latest_known, openclaw_advisory.

Amend 0001 in place (not a new 0002 migration) because no databases exist in the wild. The schema_versions table records version 1; future migrations will be version 2+.

## Alternatives considered

Add a 0002_commitments_and_columns.sql migration. Rejected because the pre-ship migration split would add complexity with no benefit — there are zero existing databases to migrate forward.

## Consequences

0001_initial.sql is now the single source of truth for the v1 schema, consistent with ARCHITECTURE.md. Any future schema change that happens after the first user database exists must be a new numbered migration with its own ADR.
