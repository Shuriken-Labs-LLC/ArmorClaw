# Dashboard JS extraction plan

The inline `<script>` in `wrapper/dashboard/public/index.html` is ~2,340 lines of untyped JavaScript. TypeScript can't check it, so bugs (TDZ, undeclared vars, type mismatches) are invisible until runtime. This plan covers extracting it into typed, bundled modules.

---

## Proposed modules

Based on the actual function groupings in `index.html`:

| Module                       | Key functions                                                                                                                                                                                                                                 | ~Lines |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/constants.ts`           | `NAV`, `PROVIDER_LABELS`, `PROVIDER_KEY_HINTS`, `SCHEDULE_PRESETS`, `PERM_LABELS`, `DAY_ABBRS`, `SKILL_ICONS`, `CAPABILITY_LABELS`                                                                                                            | 60     |
| `src/utils.ts`               | `escHtml`, `escAttr`, `fmtUSD`, `fmtTime`, `humaniseSkillName`, `maskKey`, `showSaveMsg`                                                                                                                                                      | 50     |
| `src/state.ts`               | All global `let` variables (`activeView`, `dashState`, `undoDismissed`, `selectedProvider`, `channelsData`, etc.) — exported as a mutable state object                                                                                        | 40     |
| `src/nav.ts`                 | `buildNav`, `showView`, `openDrawer`, `closeDrawer`, `notifyElectronAdvancedTab`                                                                                                                                                              | 50     |
| `src/sse.ts`                 | `connectSSE`, `setLive`, `syncUI` (master dispatcher)                                                                                                                                                                                         | 50     |
| `src/views/home.ts`          | `syncStatus`, `syncApprovals`, `approveAction`, `rejectAction`, `syncChannelBtns`, `syncUndo`, `doUndo`, `dismissUndo`, `syncBudget`, `syncFeed`, `translateEntry`                                                                            | 250    |
| `src/views/skills.ts`        | `loadBundledSkills`, `syncSkills`, `switchSkillsSection`, `loadClawHubSkills`, `installClawHubSkill`, `loadInstalledSkills`, `toggleInstalledSkill`, `removeInstalledSkill`                                                                   | 250    |
| `src/views/skills-import.ts` | `switchImportTab`, `analyzeSkillFile`, `analyzeSkillUrl`, `renderReportCard`, `confirmInstall`, `cancelImport`, `handleFileDrop`, drag handlers                                                                                               | 200    |
| `src/views/recipes.ts`       | `recipeCard`, `syncRecipes`, `toggleRecipe`, `changeSchedule`, `applyCustomSchedule`                                                                                                                                                          | 120    |
| `src/views/channels.ts`      | `syncChannelsView`, `loadChannels`, `renderChannelsList`, `buildTelegramSetup`, `validateTgToken`, `saveTgConfig`, `restartGateway`                                                                                                           | 260    |
| `src/views/security.ts`      | `syncSecurity` (rejection stats, sparkline, gateway status, permission grid, event feed)                                                                                                                                                      | 150    |
| `src/views/token-burn.ts`    | `syncTokenBurn`, `toggleTbBreakdown`, `saveBudget`, `resumeBudget` (metric cards, 30-day chart, skill breakdown, event table)                                                                                                                 | 170    |
| `src/views/settings.ts`      | `syncSettings`, `selectProvider`, `saveProvider`, `saveSandbox`, `saveSettingsBudget`, `loadMemory`, `viewMemory`, `clearMemory`, `reindexMemory`, `loadStartupSetting`, `toggleStartup`, `copyDashboardUrl`, `manageSubscription`, `doReset` | 200    |
| `src/views/advanced.ts`      | `loadAdvancedView`, `pollAdvancedGatewayStatus`, `refreshAdvancedHealth`, `loadAdvancedFallbackTools`, `runAdvancedCommand`, `startGatewayFromAdvanced`, `backupConfigFromAdvanced`                                                           | 200    |
| `src/chat/connection.ts`     | `chatFetchConfig`, `chatWaitForGateway`, `chatConnect`, `chatScheduleRetry`, `chatResetRetry`, `chatSendConnectAuth`, WebSocket lifecycle                                                                                                     | 160    |
| `src/chat/protocol.ts`       | `chatHandleMessage`, `chatSendToGateway`, `chatDbg`, `chatRetryDelay`                                                                                                                                                                         | 120    |
| `src/chat/ui.ts`             | `chatAddMsg`, `chatUpdateLastAgent`, `chatScrollBottom`, `chatAutoResize`, `chatSendMessage`, `chatSetConnStatus`, debug panel toggle                                                                                                         | 80     |
| `src/actions.ts`             | `pauseAgent`, `resumeAgent`                                                                                                                                                                                                                   | 15     |
| `src/main.ts`                | Boot sequence: `buildNav` calls, `connectSSE`, chat init. Re-exports window globals for inline `onclick` handlers                                                                                                                             | 30     |

**Total: 18 modules, ~2,450 lines of TypeScript** (slight increase from adding types).

---

## Bundler

**esbuild** — already a dependency (`esbuild@0.27.3` in the pnpm store). Fast, zero-config for this use case. No need to add another bundler.

```
npx esbuild src/main.ts --bundle --outfile=public/dashboard.js --format=esm --target=es2022
```

---

## Build integration

Add a `build:dashboard` script and chain it into `build:ts`:

```jsonc
// wrapper/launcher/package.json
{
  "scripts": {
    "build:dashboard": "esbuild wrapper/dashboard/src/main.ts --bundle --outfile=wrapper/dashboard/public/dashboard.js --format=esm --target=es2022",
    "build:ts": "tsc; node scripts/copy-wizard-public.mjs; npm run build:dashboard",
  },
}
```

Paths may need adjusting for CWD — alternatively use a small `scripts/build-dashboard.mjs` that calls the esbuild API programmatically to resolve paths from repo root.

---

## index.html after extraction

The `<script>` block shrinks to a single import:

```html
<!-- Before: 2,340 lines of inline JS -->

<!-- After: -->
<script type="module" src="/dashboard.js"></script>
```

Functions referenced by inline `onclick`/`onchange` attributes in the HTML need to be exposed on `window`. The `main.ts` entry point would do:

```typescript
import { showView, openDrawer, closeDrawer } from "./nav";
import { pauseAgent, resumeAgent } from "./actions";
// ... etc.

// Expose to inline event handlers
Object.assign(window, {
  showView,
  openDrawer,
  closeDrawer,
  pauseAgent,
  resumeAgent,
  // ... all functions called from HTML attributes
});
```

Longer term, migrate inline handlers to `addEventListener` calls and remove the `window` assignments.

---

## Migration strategy

1. **Extract constants + utils first** — zero UI risk, easy to validate.
2. **Extract state.ts** — centralise globals so modules can import them.
3. **Extract view modules one at a time** — each extraction = one PR. Run `npm run test:smoke` after each to catch regressions.
4. **Extract chat last** — most complex, most state, most event-driven.
5. **Wire `main.ts`** — imports everything, assigns `window` globals, runs boot sequence.
6. **Remove inline `<script>`** — replace with `<script type="module" src="/dashboard.js">`.

Each step is independently deployable. The smoke test gates every PR.

---

## Scope estimate

- **18 modules** to create
- **~2,450 lines** of TypeScript (from ~2,340 lines of JS + type annotations)
- **~40 functions** need `window` exposure for inline handlers (migrate later)
- **Estimated effort:** 6–8 focused PRs, each self-contained
