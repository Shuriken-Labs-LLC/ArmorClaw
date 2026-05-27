# ArmorClaw Brain UI — wireframe and component spec

Companion to `armorclaw-brain-spec.md` (which covers the data model and behavior). This document specifies the visual and interaction layer: layouts, components, states, copy.

Wireframes are described in ASCII rather than rendered. Where layout matters, the dimensions and proportions are noted. A designer can take this directly into Figma; an engineer can build straight from it.

## Visual system at a glance

The chosen visual direction for v1 is Warm Studio: warm paper-toned neutrals, soft daylight, gentle shadows, rounded forms, and a humanist typeface, so the app feels like a well-lit desk rather than a terminal. Emerson, the chibi character, lives in a consistent corner and carries the personality.

Personality discipline holds: character is loud in the low-stakes moments (empty states, the post-approve celebration, idle, loading) and cools to calm at the high-stakes surfaces (the irreversible-action gate, the audit log), where the user curates or approves.

The concrete Warm Studio token set still needs deriving. The grayscale-plus-amber tokens below are a leftover placeholder base to be replaced, not the Warm Studio palette. A dimmed warm variant for late-night use can follow in a later pass; the original concern about harsh bright UI at 11pm is valid, and a soft dark mode addresses it without making dark the default.

```
Background    #0e0e0f   (app shell)
Elevated      #16161a   (cards, panels)
Border        #26262c   (subtle dividers)
Foreground    #e8e8ea   (primary text)
Muted         #8b8b92   (secondary text)
Accent        #d97706   (interactive, focus)
Success       #65a30d
Warning       #ca8a04
Error         #dc2626
```

Typography: system font stack. Primary text 15px. Section labels 12px uppercase with 0.04em tracking. Headers 22px to 28px depending on level.

Border radius: 8px on cards, 6px on inputs and buttons, 4px on chips.

Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 pixels. Default gap between sibling elements is 16. Use 24 for sections.

## Layout: the app shell

```
+----------------------------------------------------------+
| [Workspace ▾]  Q3 Launch                  [Settings] [@] |  56px top bar
+--+-------------------------------------------------------+
|  | Chat title                            [Brain] [Raw]   |
|  |                                                       |
|S |                                                       |
|i |                  Conversation area                    |
|d |                                                       |
|e |                                                       |
|b |                                                       |
|a |                                                       |
|r |                                                       |
|  |                                                       |
|  +-------------------------------------------------------+
|  | [+] Type a message...                                 |  ~80px
+--+-------------------------------------------------------+
```

Sidebar: 240px wide on desktop, collapsible to 56px icon-only on narrow windows. Contains: app logo, the Emerson avatar stage (the chibi lobster, in its current state: idle, thinking, working, saved, commitment-due, awaiting-approval; see the Emerson avatar stage section), project list for the current workspace, "+ New project" button, divider, "Brain" tab, and a top-level "Commitments" destination (working name) that opens the always-on / "what's on there" list. Commitments is top-level, not buried in the brain drawer, because the user must be able to pull up everything Emerson is tracking in one place, fast.

Top bar: workspace switcher (left), current project name (center-ish), settings + user menu (right). A subtle indicator appears here when a security update is pending for the runtime (see Runtime section), so the user doesn't have to open Settings to find out.

Chat header: chat title (editable on click), Brain toggle (opens brain panel as right drawer), Raw toggle (opens the full OpenClaw suite, not just raw output, so the graduating power user can see and use the entire underlying tool). Installed runtime version and update status live in Settings → Runtime.

## Emerson avatar stage

Emerson is the app's character: a chibi lobster, the name made literal (armored, claw). He lives in a fixed avatar stage, a small framed window in the sidebar, present in every workspace. The stage is the home of the personality; the rest of the chrome stays calm.

### The frame

A rounded-rect stage with a white interior, a soft border, and the gentle Warm Studio shadow. The white interior is load-bearing: the clips render on a white, non-transparent background, so the frame's white fill makes that edge intentional (Emerson's little tank) rather than a seam against the warm paper background. The video is corner-masked to the frame radius (rounded container, overflow hidden). Suggested size: roughly 72 to 96px square in the expanded sidebar, collapsing to a small badge in the 56px icon-only sidebar.

### Clips and the anchor pose

Source assets live in the project's "Emerson the lobster animations" folder. Every clip is a seamless loop that opens and closes on the same neutral anchor pose, so any clip can follow any other without a visible jump and resting clips can loop indefinitely. `Emerson the Lobster.png` is that anchor pose; it is also the poster image (first paint) and the reduced-motion fallback.

Build note to verify: confirm each mp4 truly starts and ends on the anchor pose. Any clip that does not will pop on loop or on swap.

### State-to-clip mapping

The stage is a small state machine. Each state maps to a clip or a pool of interchangeable clips:

- idle (resting, no activity): pool of `EmersonIdle`, `JustChilling`, `EmersonVibing`. Play one; on loop-end either replay or pick another at random. Keep it sparse so it reads calm, not hyperactive.
- thinking (agent is reasoning or retrieving from the brain): pool of `EmersonThinking`, `EmersonReading`.
- working (agent is producing output or running a tool): pool of `EmersonWriting`, `EmersonCooks`, `EmersonRunning`.
- saved (a memory was just approved): `EmersonRemembers`, played once on propose-card approval, then return to idle. The celebratory beat.
- commitment-due (a scheduled commitment fires or a reminder surfaces): `Remindertodosomethingatasettime`.
- awaiting-approval (the irreversible-action gate): `EmersonWarning`, played once and held. No pool, no randomness. Predictability is part of the trust signal at the gate, per the personality discipline.

A dedicated greeting clip for onboarding is not in the current set; reuse an idle-pool clip (`EmersonVibing` reads welcoming) until one exists.

### Discipline and accessibility

Variety and liveliness belong in the low-stakes states (idle, thinking, working). At the high-stakes surfaces, the gate and the audit log, Emerson drops to the single calm clip or the static anchor pose. Respect `prefers-reduced-motion`: when set, show `Emerson the Lobster.png` as a static poster instead of looping video, which doubles as the calm-at-high-stakes behavior.

### Implementation notes

Use a `<video>` element with loop, muted, autoplay, playsinline, and preload. For seamless variety, preload the next clip and cut at the shared anchor frame, or stack two video elements and swap. The png poster gives instant first paint before the clip loads. An `<EmersonStage>` component takes the current state and owns pool selection, the gate exception, and the reduced-motion branch.

## Brain panel — overlay or drawer

Opens as a 480px-wide right-side drawer overlaying the chat. Closes with Escape or by clicking outside. The drawer is the entire brain surface; layers 0 through 4 happen inside it, navigated via breadcrumbs.

```
+--+-----------------------------+--------------------+
|  |                             |  Brain        [×]  |
|  |  Chat                       |  ---               |
|  |                             |  [breadcrumb here] |
|  |                             |                    |
|  |                             |  [current layer]   |
|  |                             |                    |
|  |                             |                    |
+--+-----------------------------+--------------------+
```

Optional: a "pin open" toggle on the drawer header that makes it persistent. When pinned, the chat area resizes to accommodate it. Useful for users actively curating memories.

## Layer 0: workspace overview

Default view when Brain is opened with no further navigation. Shows the user where they are and what's available.

```
+----------------------------------+
| BRAIN — Workspace: Work     [×]  |
| Workspaces ▾                      |
+----------------------------------+
| 🔍 Search this workspace          |
+----------------------------------+
| Projects (3)                      |
|                                   |
|   ┌─────────────┐  ┌────────────┐ |
|   │ Q3 Launch   │  │ Hiring     │ |
|   │ 23 memories │  │ 12 memories│ |
|   │ 4 topics    │  │ 3 topics   │ |
|   │ 2h ago      │  │ 2 days ago │ |
|   └─────────────┘  └────────────┘ |
|   ┌─────────────┐                 |
|   │ Vendor mgmt │                 |
|   │ 8 memories  │                 |
|   │ 1 topic     │                 |
|   │ 1 week ago  │                 |
|   └─────────────┘                 |
|                                   |
| Recent memories (last 10)         |
|   • Sarah prefers Tuesday        |
|     standups (Q3 Launch, 2h)      |
|   • Q3 launch date: Aug 15        |
|     (Q3 Launch, yesterday)        |
|   ...                             |
+----------------------------------+
```

Component breakdown:

Workspace selector at the top is the same dropdown that's in the app top bar, surfaced again for context. Clicking switches workspaces and reloads layer 0.

Search bar: searches across all memories, notes, and entities in the active workspace. Live filtering. Results render below as you type.

Project cards: 220px wide, 100px tall. Click to drill into layer 1. Hover state: slight elevation, accent border. Right-click context menu: rename, change icon/color, archive, export.

Empty state for projects: "No projects yet. Create one to start adding memories." with a `[Create project]` CTA.

Recent memories strip: 10 most recently approved memories across all projects in this workspace. Each entry has subject, parent project, time elapsed. Click to open the memory drawer (layer 3).

## Layer 1: project view

Reached by clicking a project card.

```
+--------------------------------+
| BRAIN — Work > Q3 Launch  [×]  |
| < Back to workspace             |
+--------------------------------+
| Q3 Launch                       |
| Internal launch of the new...   |
| [Edit project]                  |
+--------------------------------+
| Topics                          |
| [Team ops 8] [Marketing 5]      |
| [Vendor 4] [Hiring 3] [+ Topic] |
+--------------------------------+
| 🔍 Filter memories               |
| Sort: ▾ Newest                  |
+--------------------------------+
| ☑ Sarah's standup preference    |
|   Sarah prefers Tuesday...      |
|   Team ops · Sarah · 2h         |
+--------------------------------+
| ☑ Q3 launch date                |
|   The Q3 launch is locked to... |
|   Marketing · Aug 15 · 1d       |
+--------------------------------+
| ⓘ Proposed: pricing tier        |
|   The new pricing tier is $19...|
|   pending review · 3h           |
+--------------------------------+
|                                 |
| ENTITIES                        |
| People (4): Sarah, Mike, ...    |
| Events (2): Launch Day, ...     |
| Projects (1): Q3 Launch         |
+--------------------------------+
```

Component breakdown:

Project header: name, optional description. Edit opens an inline form. Memory and topic counts shown subtly.

Topic chips: horizontally scrollable row. Each chip shows name and memory count. Clicking a chip drills into layer 2 (filtered to that topic). "+ Topic" creates a new topic, then immediately opens an empty topic view (the user can add memories to it from there or it will populate when the agent classifies a future memory into it).

Memory list: each row is a memory card. Status icons on the left:
- ☑ approved (most common; subtle)
- ⓘ proposed (highlighted; needs review)
- ✗ rejected (faded; only shown if user toggles "show rejected")

Each card shows: subject (1 line, truncate at 60 chars), summary (1 line, muted), and a metadata footer with topic, entity, and elapsed time. Click to open the memory drawer.

Filter and sort: filter is a fuzzy search across this project's memories only. Sort options: Newest (default), Oldest, Alphabetical, Highest confidence, Lowest confidence (useful for review).

Entities sidebar: a collapsible right rail showing entity counts. Click a category to expand; click an entity to drill into layer 4.

Empty state for the project: "No memories yet. Start a chat and the agent will propose things to remember." with a "Go to chat" CTA.

## Layer 2: topic view

Reached by clicking a topic chip.

```
+--------------------------------+
| BRAIN — Work > Q3 Launch >     |
|         Team operations    [×] |
| < Back to project               |
+--------------------------------+
| Team operations                 |
| 8 memories · 4 entities         |
| First memory: 3 weeks ago       |
| [Generate dossier]              |
+--------------------------------+
| 📌 Pinned dossier (3 days ago)  |
|   "Team operations: overview"   |
|   [View] [Regenerate] [Archive] |
+--------------------------------+
| ☑ Sarah's standup preference    |
| ☑ Standup duration ...          |
| ☑ Slack channel for ops ...     |
| ...                             |
+--------------------------------+
| Related topics                  |
| Hiring (2 shared entities)      |
| Vendor mgmt (1 shared entity)   |
+--------------------------------+
```

Components:

Topic header: name, memory count, entity count, age of oldest memory. The "Generate dossier" button is the primary CTA.

Dossier section: appears only when there are pinned dossiers OR after generation. When generating, this is where the loading state appears:

```
| Generating dossier...           |
| Reading 8 memories...           |
| [progress indicator]            |
```

Generated dossier renders inline, as collapsed-by-default with a "Show full dossier" expander. Has Copy as markdown, Save to file, Pin/Unpin buttons.

Memory list: same component as layer 1, filtered to this topic.

Related topics: footer showing other topics that share entities with this one. Clicking a related topic switches to that topic's layer 2 view.

## Layer 3: memory detail drawer

Opens as a sub-drawer over the current brain panel (or as a modal on narrow widths). Reached by clicking a memory.

```
+-----------------------------+
| Memory                  [×] |
+-----------------------------+
| Sarah's standup preference  |
|                             |
| Summary                     |
| Sarah prefers Tuesday       |
| standups.                   |
|                             |
| Full memory                 |
| Sarah mentioned this on May |
| 12 in the planning chat.    |
| Was related to her morning  |
| commute schedule.           |
|                             |
| Topic                       |
| [Team operations] [Change]  |
|                             |
| Entities                    |
| [Sarah ×] [Weekly Standup ×]|
| [+ Add entity]              |
|                             |
| Confidence                  |
| 85%                         |
|                             |
| Source                      |
| Chat: "May 12 planning"     |
| [Jump to source]            |
|                             |
| Created: 5 days ago         |
| Updated: 2 days ago         |
|                             |
| [Find related across all    |
|  workspaces]                |
|                             |
| [Edit] [Delete] [Reject]    |
+-----------------------------+
```

Components:

Each field is inline-editable. Click the value, it becomes an input, Escape cancels, Enter or click-away saves.

Topic and entity chips are clickable: click to drill into that entity (layer 4) or topic (layer 2).

"Find related across all workspaces" triggers the cross-walk modal (see below).

Edit / Delete / Reject buttons are at the bottom. Delete asks for confirmation; Reject moves the memory to status='rejected' without deleting.

## Layer 4: entity detail view

Reached by clicking an entity chip anywhere.

```
+-----------------------------+
| BRAIN — Entity: Sarah  [×]  |
| < Back                       |
+-----------------------------+
| Sarah (person)              |
| Aliases: Sarah K, S. Kim    |
| [Edit entity]               |
+-----------------------------+
| 7 memories mention Sarah    |
| Across 2 projects in Work   |
+-----------------------------+
| ☑ Sarah's standup pref...   |
|   Team ops · Q3 Launch      |
| ☑ Sarah's hiring focus...   |
|   Hiring · Hiring           |
| ...                         |
+-----------------------------+
| Co-occurs with              |
| [Mike] [Weekly Standup]     |
| [Q3 Launch] [Hiring]        |
+-----------------------------+
| [Find related across all    |
|  workspaces]                |
+-----------------------------+
```

Co-occurrence: entities that appear in the same memories as this one. Visible at a glance as chips. Clicking a co-occurring entity drills into its layer 4.

The cross-walk button works the same way as on a memory.

## Propose card (in chat)

This is the most important UI moment in the whole app. The user is in the middle of a conversation; the card has to be informative without breaking flow.

The propose card is a single primitive with four payloads, not just a memory saver. It is the one "Emerson asks before something that matters" interaction:

- Memory: "Save to brain?" (the original, specified in full below).
- Commitment: "Track this for you?" (a new always-on task, with trigger, autonomy mode, and done-condition).
- Setting change: "Update a setting?" (when a reliability or safety preference is implied by something the user said or edited in their instructions; the structured change is proposed rather than silently applied).
- Irreversible-action gate: "Approve this action?" (shown before any irreversible action). This replaces the separate "approval prompt" UI described in the onboarding spec, so there is one mental model and one explainer.

All four reuse the same card chrome, the same focus order, and the rule that Enter never approves. The gate variant never auto-approves and is the surface the security floor depends on. The memory variant is specified below; the others inherit its structure.

```
┌─────────────────────────────────────────────────┐
│ 🧠 Save to brain?                                │
│                                                  │
│ Sarah's standup-day preference                   │
│                                                  │
│ Sarah prefers Tuesday standups. She mentioned    │
│ this on May 12 in the planning chat. Was related │
│ to her morning commute schedule.                 │
│                                                  │
│ Topic:   [Team operations ▾]                     │
│ Project: [Q3 Launch ▾]                           │
│ Entities: [Sarah ×] [Weekly Standup ×]           │
│ Confidence: ████████░░ 85%                       │
│                                                  │
│  [Edit]                  [Reject]    [Approve]   │
└─────────────────────────────────────────────────┘
```

Behaviors:

The card renders inline in the chat, between agent and user messages. As the conversation continues, it scrolls naturally. It does not modal or block.

While the save-time classification is still running, the Topic and Entities fields show "Classifying..." in muted text, then update in place when the classifier returns.

Topic dropdown: most-recently-used topics first (10), then "+ Create new topic" at the bottom.

Project dropdown: projects in the current workspace, then "+ Create new project" at the bottom. Default selected is the active project.

Entity chips: click an entity to edit or remove. "+ Add entity" opens a small popover with an input and a type selector.

Confidence: a slider on Edit, a read-only bar on the default view. Range 0 to 1, shown as a percentage.

Buttons: Edit (expands the card into a full edit view), Reject (discards, with a soft animation that removes the card), Approve (commits the memory). Default focus is on the card body. Tab order: Edit, Reject, Approve. Enter does NOT trigger Approve.

After Approve, the card animates to a compact "✓ Saved to Team operations" badge that the user can click to navigate to the memory.

After Reject, the card animates to nothing.

## Cross-walk results modal

Reached by clicking "Find related across all workspaces" on a memory or entity.

```
+---------------------------------------------+
| Cross-walk: Sarah                       [×] |
+---------------------------------------------+
| Searching all workspaces...                 |
| Found 5 matches in 2 other workspaces.      |
+---------------------------------------------+
| Personal > Wedding planning (3)             |
|   • Sarah's RSVP for the wedding... [view]  |
|   • Sarah's plus-one is... [view]           |
|   • Sarah's dietary restriction... [view]   |
+---------------------------------------------+
| Side projects > Cooking blog (2)            |
|   • Sarah's feedback on the recipe... [view]|
|   • Sarah's Instagram handle is... [view]   |
+---------------------------------------------+
| Nothing is added to your current chat.      |
| [Open in original context] [Close]          |
+---------------------------------------------+
```

The matched memories are read-only here. Clicking [view] opens the memory drawer for that specific memory, but in a "you're viewing a memory from another workspace" mode. Editing requires switching to that workspace.

The footer copy reminds the user that cross-walks don't pull content into the agent's context; that requires switching workspaces.

## Brain mode selector (in project settings)

Lives in project settings, not in the brain panel proper. Reached via the project header's [Edit project] button.

```
+---------------------------------------------+
| Q3 Launch — Settings                        |
+---------------------------------------------+
| Name         [Q3 Launch                  ]  |
| Description  [Internal launch of...      ]  |
| Icon         [🚀]  Color  [● orange]        |
+---------------------------------------------+
| Brain mode                                  |
|                                             |
| ◉ Smart (recommended)                       |
|   The agent looks up memories when relevant.|
|   ~120 tokens per turn at current size.     |
|                                             |
| ○ Manual                                    |
|   The agent only checks memories when you   |
|   explicitly ask.                           |
|   ~20 tokens per turn.                      |
|                                             |
| ○ Full                                      |
|   All memories load at chat start.          |
|   ~1,840 tokens per turn at current size.   |
|   ⚠ This project has 23 memories. Full mode |
|   works comfortably up to ~100.             |
+---------------------------------------------+
| [Archive project]            [Save]         |
+---------------------------------------------+
```

The token estimates update live as memories are added or removed. The warning under Full mode appears only when memory count crosses thresholds (around 50 first, around 100 with a stronger warning).

## Commitments surface (the always-on / "what's on there" list)

New in this revision. The always-on layer (intent memory) gets its own top-level destination in the sidebar, separate from the knowledge brain. It reads from the `commitments` table in the same SQLite brain file. It is not a memory type.

```
+------------------------------------+
| COMMITMENTS — Emerson is tracking  |
+------------------------------------+
| Next up                            |
|  • 7:00 AM daily — Morning brief   |
|    autonomous · last ran 2h ago    |
|  • Fri 9:00 — Email Sarah re: Q3   |
|    needs approval · irreversible   |
+------------------------------------+
| Paused (1)                         |
|  • Weekly vendor summary (paused)  |
+------------------------------------+
| [+ New commitment]                 |
+------------------------------------+
```

Each row shows description, trigger (time, interval, or manual for v1), autonomy mode (gated or autonomous), reversibility, status, and last run. Click a row for a detail view with the editable fields, the run history (which is also the plain-text audit trail for that commitment), and the per-item missed-run policy.

Rules carried from this session's decisions:

- Commitments always execute regardless of the project's brain access mode. Smart, manual, and full govern knowledge retrieval only, never execution. A user in manual mode must never have invisible tasks firing.
- Autonomy is keyed to reversibility. Reversible actions can run hands-off. Irreversible actions stay gated unless the user makes a separate, deliberate, off-by-default opt-in that names what they authorize.
- Missed-run policy defaults to ask, switchable per item to skip or run-on-next-wake.
- The briefing is itself a recurring commitment, not a separate subsystem. The default morning brief is a pre-seeded row the user can edit or delete.
- Emerson answers "what's on there" conversationally by querying this same table, so the spoken answer and the visual list can't disagree.

## Instructions / policy layer

New in this revision. The editable, prose, user-owned steering layer. Scoped workspace then project, mirroring the brain's hierarchy.

Lives as an "Instructions" section in workspace settings (global Emerson behavior, tone, default cadence, what to track) and in project settings (per-project overrides). The user edits plain prose, never JSON.

Hard rule: prose is the policy, structured records are the contract. When a prose edit implies a structured change that touches reliability or safety (a schedule, the autonomy default, the gate), Emerson proposes the structured change via the propose card rather than reinterpreting the sentence at runtime. The scheduler and gate read structured values, never the prose.

## Settings (global)

The top-bar Settings button was previously unspecified. It now contains, at minimum:

- Account: email, subscription status, one-click cancel, one-click refund (per the monetization decisions).
- Runtime: see below.
- Personality: the standard / unhinged toggle. User-facing only, standard is the default, and it never affects content sent to third parties, only how Emerson talks to the user.
- Autonomy default and missed-run default: the structured settings the instructions layer compiles into.
- Model key management: the key captured during onboarding lives here for rotation, stored in the OS keychain.
- Integrations / skills gallery: curated versus community (intersects the open question on the skills surface).

## Runtime and version transparency

New in this revision, and non-optional per this session. The user must always be able to see what they are running and whether it is current. Hiding the runtime version while charging for a security story would be dishonest, and the security floor is built on honesty.

```
+---------------------------------------------+
| Settings — Runtime                          |
+---------------------------------------------+
| OpenClaw                                    |
|   Installed: 0.x.y                          |
|   Latest:    0.x.z   [Update]               |
|   ⚠ A security advisory affects your version|
|     [Read advisory] [Update now]            |
+---------------------------------------------+
| ArmorClaw                                   |
|   Version 1.x.y · up to date                |
+---------------------------------------------+
| [Open the full OpenClaw suite]              |
+---------------------------------------------+
```

Shows installed OpenClaw version against latest, a one-click update, and a prominent, non-dismissable indicator when the installed version carries a known advisory. A subtle indicator also appears in the app shell top bar so the user learns about a pending security update without opening Settings. The update channel (Cloudflare) must carry OpenClaw's upstream version and advisory feed in addition to ArmorClaw's own updates.

## Component inventory (for the design system)

These components are reusable across the brain UI and beyond:

`<MemoryCard>` props: memory object, variant (list / drawer / propose), onApprove, onReject, onEdit, onClick. Used in layer 1, layer 2, propose card, layer 3 detail.

`<TopicChip>` props: topic object, isActive, onClick. Used in layer 1, layer 4, memory detail.

`<EntityChip>` props: entity object, isClosable, onRemove, onClick. Used in propose card, memory detail, entity sidebar.

`<ProjectCard>` props: project object, onClick. Used in layer 0.

`<Breadcrumbs>` props: items array. Used at the top of each brain layer.

`<Drawer>` props: isOpen, onClose, side, isPinned, width, children. Used for the brain panel itself.

`<ConfirmDialog>` props: title, body, dangerLabel, onConfirm, onCancel. Used for delete confirmations, archive confirmations, mode switch warnings.

`<TokenCostEstimate>` props: projectId, mode. Computes the estimate live by querying memory count and applying the per-mode formula.

`<EmersonStage>` props: state (idle / thinking / working / saved / commitment-due / awaiting-approval), reducedMotion. Owns the framed stage, clip-pool selection per state, the no-variety gate exception, and the static-poster fallback. Used in the sidebar.

## Empty states

The empty state copy matters as much as the populated state because it appears most for new users. These are also the prime home for Emerson's personality (standard voice). The copy below is the plain placeholder; rewrite it in Emerson's voice once the final visual and voice pass is done. Every empty state should still be one short sentence plus one CTA.

Workspace overview with no projects: "Start with a project. Anything you're actively working on, big or small, will benefit from a workspace." CTA: Create your first project.

Project view with no memories: "When you talk to the agent here, it will propose things to remember. You decide what's worth keeping." CTA: Open chat.

Topic view with one memory: "Just one memory under this topic so far. Add more by talking to the agent or creating memories manually." CTA: Open chat.

Entity view with no co-occurring entities: "Sarah is mentioned in only one memory so far. As you accumulate more, relationships will appear here."

Cross-walk with no results: "Nothing matched. The agent doesn't see anything related elsewhere."

Search with no results in current workspace: "No memories or notes match that query in this workspace. Try the cross-walk to search elsewhere?"

## Keyboard shortcuts

These should be live by week 8:

Cmd/Ctrl + K: focus search in the current brain layer.
Cmd/Ctrl + B: toggle brain panel.
Cmd/Ctrl + Shift + B: toggle brain panel pinned-open mode.
Escape: close drawer / dismiss modal / cancel edit.
Tab / Shift+Tab: navigate fields in edit modes.
Cmd/Ctrl + Enter: submit form (e.g., approve a propose card if it has focus).

Resist building a fuller hotkey system in v1. The five above cover the actual hot paths.

## Loading and error states

Loading: skeleton cards in the same shape as the populated version. Animated shimmer. Should resolve in under 200ms for most queries; if it exceeds 800ms, surface a "this is taking longer than usual..." message at 1 second.

Error: red banner at the top of the affected component with the error message and a "Retry" button. Never replace the whole panel with an error screen unless the error is unrecoverable (e.g., database corruption).

Optimistic updates: approve, reject, edit memory should all update the UI before the database write returns. Roll back on failure with a toast notification.

## Responsive behavior

The brain panel works at 480px width minimum. Below 600px viewport width (rare on desktop but possible on a side-by-side window arrangement), the panel takes the full chat area instead of overlaying.

Truly narrow widths (under 480px) aren't a v1 target. Mac users running the app at sub-500px width are a tiny fringe. Don't design for it. (v1 is macOS only; Windows was cut this session.)
