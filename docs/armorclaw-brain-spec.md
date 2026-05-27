# ArmorClaw Brain — v1 spec

The brain is the value prop. Everything else (the wrapper, the integrations, the notifications) is justified by it. If the brain feels generic, ArmorClaw is a $19.99 wrapper. If the brain feels alive, ArmorClaw is the agent OpenClaw should have been.

This document specifies the v1 brain. It assumes the locked decisions: three-layer hierarchy, default-silo with opt-in cross-walks, entity + topic + summary at save time, per-topic dossier as the primary readable view.

## Concept

Three layers, top to bottom: workspace, project, memory.

A workspace is a life domain. Work. Personal. Side projects. Household. It groups projects that share context but should not be agent-confused (the agent should not bring up your dating life while you're writing a hiring plan).

A project is a specific ongoing effort within a workspace. "Q3 Launch", "Hiring Lead Eng", "Refinance the mortgage", "Wedding planning". This is where the agent's attention lives. Chats happen inside projects. Memories belong to projects.

A memory is an atomic fact or decision. "Sarah prefers Tuesday standups." "The Q3 launch date is August 15." "Dad's anniversary gift budget is $200." Memories carry entities (who and what they reference) and a topic label that emerges from use. This is knowledge memory. ArmorClaw also has intent memory, commitments the agent will act on, which is a sibling concept covered in its own section below. Where this doc says "memory" unqualified, it means knowledge memory.

Topics are not a fourth layer. They are tags that the agent applies at save time. Two memories with the same topic label cluster naturally without the user managing a tag taxonomy.

## Save-time agent work

When the agent proposes a memory, it does not just return the subject and value. It returns a structured payload:

```
{
  "subject": "Sarah prefers Tuesday standups",
  "value": "She mentioned this on May 12 in the planning chat. Was related to her morning commute schedule.",
  "summary": "Sarah's standup-day preference",
  "confidence": 0.85,
  "entities": [
    { "type": "person", "name": "Sarah", "aliases": ["Sarah K"] },
    { "type": "event", "name": "Weekly Standup" }
  ],
  "topic": "Team operations",
  "topic_is_new": false,
  "suggested_project_id": "uuid-of-current-project"
}
```

Cost: one extra LLM call per proposed memory beyond the one already generating the proposal. About 200 to 400 output tokens. At Claude 3.5 Sonnet pricing this is roughly $0.001 per memory. Not material at any reasonable usage level.

The agent assigns topic by consulting a per-workspace topic list, returned to it as part of context. "Here are the topics already in this workspace: Team operations, Hiring, Vendor management, Marketing. Pick the closest match, or if none fits, propose a new one. Be conservative about creating new topics; reuse where possible."

The "topic_is_new" boolean lets the UI flag it differently: "First memory under new topic 'Customer interviews' (create?)" versus "Adding to existing topic 'Team operations'."

The suggested_project_id is the active project the user is currently chatting in. The agent can override if it strongly believes the memory belongs in a sibling project, but defaults to the active one.

## Propose card UI

When the agent proposes, an inline card appears in the chat. Not a modal. A card, anchored in the conversation, so it stays scrollable as the chat continues.

```
+--------------------------------------------------+
|  Save to brain?                                   |
|                                                   |
|  Sarah's standup-day preference                   |
|  Sarah prefers Tuesday standups. She mentioned    |
|  this on May 12 in the planning chat. Was         |
|  related to her morning commute schedule.         |
|                                                   |
|  Topic: Team operations    Project: Q3 Launch ▾   |
|  Entities: Sarah, Weekly Standup                  |
|  Confidence: 85%                                  |
|                                                   |
|  [Approve]  [Edit]  [Reject]                      |
+--------------------------------------------------+
```

Behaviors:
- Topic is a dropdown showing existing topics in the workspace plus "+ Create new"
- Project is a dropdown showing projects in the current workspace plus "+ Create new project"
- Entities can be deleted or renamed inline
- "Edit" expands the card to allow editing subject, value, summary
- "Approve" commits to the brain
- "Reject" discards
- Cards never auto-approve. Ever.

The default focus is on the card's center, not on "Approve." Tab order: Approve, Edit, Reject. Enter does NOT trigger Approve by default; the user must intentionally click or arrow-to it. This is consistent with the "irreversible action requires deliberate confirmation" pattern from the security floor.

The propose card is one primitive with four payloads: a knowledge memory (above), a commitment (intent memory; see below), a reliability or safety setting change implied by an instructions edit, and the irreversible-action approval gate. All four share this card's chrome, focus order, and no-auto-approve rule. The gate variant is the surface the security floor depends on.

## Brain panel — progressive disclosure

The brain panel is the second-most-important surface after the chat. It is reachable via a sidebar tab in every workspace.

The panel is structured in layers, each revealing more detail as you click in.

### Layer 0: workspace overview

The top-level view when you click "Brain" with no further selection. Shows:

- All projects in the current workspace, as cards
- Each card shows: project name, project icon, count of memories, count of topics, last activity timestamp
- A search bar that searches everything in the workspace
- A "Recent memories" strip below: the last 10 memories across all projects

### Layer 1: project view

Clicking a project card drills into it. Shows:

- Project header: name, description, icon, edit
- Topic shelf: clickable chips for each topic in this project, with memory counts
- Memory list: all memories in this project, sortable by recency, alphabetical, confidence
- Entity sidebar: people, projects, events mentioned in this project's memories

### Layer 2: topic view

Clicking a topic chip narrows the memory list to that topic plus shows:

- Topic header: name, memory count, time range of memories under this topic
- "Generate dossier" button (see next section)
- Memory list filtered to this topic only
- A "Related topics" footer: other topics that share entities with this one

### Layer 3: memory detail

Clicking a memory opens a side drawer or modal:

- Subject and full value text
- Topic, project, entities listed and clickable
- Source chat link: jumps to the chat where the memory was proposed
- Timestamp, confidence, edit history
- "Find related across all workspaces" button (cross-walk; see section below)
- Edit, delete, change topic, change project

### Layer 4: entity view

Clicking an entity (a person, a project, an event) opens an entity page within the workspace:

- Entity header: name, type, aliases
- All memories in this workspace that mention the entity
- A small relationship graph: which other entities co-occur with this one
- "Find related across all workspaces" button

Layers 0 through 4 are always reachable from each other via breadcrumbs at the top.

## Per-topic dossier — the readable view

A dossier is a structured human-readable document the agent generates on demand from the memories under a single topic.

User flow:

1. User clicks into a topic
2. User clicks "Generate dossier"
3. Loading state: "Reading 23 memories across 4 months..."
4. After 5 to 15 seconds, dossier renders inline in the brain panel
5. User can copy to clipboard, export as markdown, or pin to the topic for later

The dossier prompt to the agent:

> You are summarizing the user's memories under the topic "[topic name]" in their "[workspace name]" workspace. There are [N] memories. Produce a human-readable briefing document with sections appropriate to the content: typically Overview, Key facts, People involved, Decisions made, Open questions. Cite memory IDs in line where relevant so the user can drill back. Do not invent. If a memory contradicts another, surface the contradiction.

Output: 400 to 1000 words of markdown, agent-written, with [Memory #N] inline citations that link back to the source memory.

Storage: dossiers are not auto-saved. Each generation is fresh. The user can pin a dossier to the topic; pinned dossiers persist with a "generated on [date]" stamp. Regenerating creates a new version; old pinned dossiers archive automatically.

Cost: roughly 2,000 to 5,000 input tokens (the memories) and 600 to 1,500 output tokens. About $0.01 to $0.03 per dossier generation. Cheap enough not to gate.

Export: every dossier has a "Copy as markdown" and "Save to file" option. The markdown is plain text, no proprietary format.

## Cross-workspace cross-walks

Default: silos hold. The agent's conversation context never includes content from other workspaces.

Opt-in: every memory and every entity has a "Find related across all workspaces" button. Clicking it runs an entity-matching search across all workspaces and returns:

- Number of memories per workspace that match
- A preview list per workspace (clickable to view in context)
- No content is loaded into the current agent conversation

Nothing is persisted. Each click is fresh. No "always link Sarah" toggle in v1.

If the user wants to bring a memory from another workspace into the current conversation, the only way is to manually copy-paste the value or to switch workspaces. This is intentionally a tiny bit of friction; it makes cross-workspace contamination an act of intent, not accident.

Behavior when no entities are found across workspaces: show an empty state, "Nothing matched. The agent doesn't see anything related elsewhere."

## Intent memory: commitments

Knowledge memory remembers facts. Intent memory remembers things to do. A commitment is a thing the agent will carry out on a trigger: "every weekday at 7am, brief me on my inbox," "Friday, remind me to email Sarah about Q3," "when I say so, summarize the vendor thread." Commitments are what make "doesn't forget to do things" true, and they are a v1 pillar, not a memory subtype.

Commitments share the workspace-then-project hierarchy and the entity and topic tags, but they live in their own table and are never part of the FTS index. They carry a trigger (time, interval, or manual in v1; event-driven is v1.x), an autonomy mode, a reversibility flag, a done-condition, and a missed-run policy. The structured record, not any prose, is what the scheduler executes. See ARCHITECTURE for the table and the scheduler.

### commit.propose

Mirroring brain.propose, the agent proposes a commitment when it detects one in conversation. The same inline card appears, in its commitment variant:

```
+--------------------------------------------------+
|  Track this for you?                              |
|                                                   |
|  Brief me on my inbox every weekday at 7am        |
|                                                   |
|  Trigger: daily 07:00 (Mon-Fri)                   |
|  Autonomy: autonomous (reversible)                |
|  Project: Work                                    |
|                                                   |
|  [Approve]  [Edit]  [Reject]                      |
+--------------------------------------------------+
```

Same rules as brain.propose: it never auto-approves, Enter does not approve, and the user can edit the trigger, autonomy, and scope before approving. On approval the commitment is written as a structured record and the scheduler picks it up.

### The "what's on there" surface

Commitments get their own top-level destination (see the brain UI spec), not a spot buried in the brain panel, because the user must be able to see everything Emerson is tracking in one place. It reads active and paused commitments from the table, grouped by next fire time. The agent answers "what's on there" by querying the same table, so the list and the spoken answer cannot diverge.

### Instructions: the prose policy layer

A user who does not speak JSON steers Emerson by editing prose. Each workspace and project has an editable instructions field, the policy: tone, what to track, default cadence, preferences. The structured records (commitments, the autonomy and missed-run settings, the gate) are the contract. The scheduler and gate read the contract, never the prose, so reliability and safety cannot be edited away in a sentence. When a prose edit implies a structured change, the agent proposes it via the propose card rather than reinterpreting the sentence each run.

## Data model additions

New table:

```
projects
  id (uuid)
  workspace_id (fk -> workspaces.id)
  name
  description
  icon
  color
  sort_order
  created_at
  updated_at
```

Modified tables:

`chats` gets a `project_id` (fk -> projects.id). The existing `workspace_id` becomes denormalized for query convenience, derived from the project.

`memories` gets a `project_id` (fk -> projects.id). The existing `workspace_id` becomes derived.

`notes` gets a `project_id`.

`attachments` gets a `project_id`.

New tables:

```
entities
  id (uuid)
  workspace_id (fk)
  name
  type            -- person | project | event | organization | place | thing
  canonical_id    -- nullable; future, for entity merging
  created_at
  updated_at

memory_entities
  memory_id (fk)
  entity_id (fk)
  PRIMARY KEY (memory_id, entity_id)

topics
  id (uuid)
  workspace_id (fk)
  name
  description
  created_at

memory_topics
  memory_id (fk, unique)        -- a memory has exactly one topic in v1
  topic_id (fk)

dossier_pins
  id
  topic_id (fk)
  content_md
  generated_at
  is_archived
```

The agent at save time writes to memories, memory_entities, and memory_topics atomically. If entities or topics referenced don't exist, they are created first.

## Storage paths

No change from current ARCHITECTURE.md. All new tables live in the same `armorclaw.db` SQLite file. Dossier pins are markdown columns; no separate file storage.

## Workspace export

Cheap migration-path commitment from the pricing page. Implementation: a "Export workspace" button in workspace settings that writes a folder tree:

```
[workspace-name]/
  [project-name]/
    chats/
      2026-05-19-conversation-title.md
    notes/
      [note-title].md
    memories.md            -- all memories in this project, structured
    dossiers/
      [topic-name].md      -- pinned dossiers per topic
  README.md                -- workspace overview, project list
```

Plain markdown, no proprietary format. User can grep it, version it, move it. This is the trust signal. Worth the engineering cost (estimated 1 to 2 days).

## What's explicitly NOT in v1 brain

Visual graph view (force-directed nodes and edges). Defer to v2. It is harder to make useful than to make pretty.

Semantic search and embeddings. Already deferred per ARCHITECTURE.md.

Persistent cross-workspace entity linking ("Sarah here is the same as Sarah there"). v2.

Auto-merging of duplicate memories. v1.1 candidate after we see how often it actually happens in practice.

Memory versioning beyond simple updated_at. If a memory is edited, the old version is overwritten. Acceptable for v1.

Memory expiry or auto-pruning. The user prunes manually. We can add suggestions ("You haven't accessed these 12 memories in 6 months. Archive?") in v1.1.

Multi-topic memories. A memory has exactly one topic in v1. If a memory genuinely spans topics, the user should split it. This constraint dramatically simplifies the UI.

A "Brain dashboard" with metrics (memories per day, top topics, etc.). Cute, not useful. Defer.

Event-driven commitment triggers ("when X happens"). v1 commitments fire on a schedule or manually; event triggers are v1.x.

Commitment export to markdown. The workspace export covers knowledge memory in v1; commitment export is v1.x.

## UX-critical details often missed

The topic dropdown on the propose card uses MRU ordering (most recently used), not alphabetical. Most propose-card decisions are about reusing an existing topic the user just engaged with.

When a new project is created from the propose card flow, the user lands in the chat with a confirmation toast at the bottom: "Memory saved to new project: Q3 Launch. [View project]." Don't yank them out of the chat.

Entity rename in the propose card is a per-memory edit, not a global rename. Global entity rename happens from the entity detail view and propagates to all memories that reference it.

Cross-walk results show workspace name and project name for each match. "5 memories in Personal > Wedding planning." Without the project, the cross-walk is opaque.

Pinned dossiers carry a "generated on" date prominently. Old pins age out of usefulness fast. Make it visible.

## Open questions to resolve before implementation

How does the agent know which existing topics to consult at propose time? The naive answer is "send all of them in context." For a workspace with 200 topics, that's a lot of tokens. We may need a pre-filter: send the 20 most recently used topics plus the 10 most-used, total 30. Worth specifying in the propose-time prompt assembly.

What happens to memories when a project is deleted? Three options: (a) hard delete, (b) move to a special "Archive" project in the same workspace, (c) move to the workspace's default project. I lean toward (a) with a strong confirmation, with the option for the user to export the project first.

How are projects ordered in the workspace overview? Manual drag-to-reorder, or auto by last-activity? Probably last-activity by default with manual override. Pin-to-top option for the user's current focus.

Should empty projects be hidden? "I created this project a month ago but never put anything in it." I'd suggest a "Show empty projects" toggle in the workspace overview, off by default.
