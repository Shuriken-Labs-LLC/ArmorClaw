# OpenClaw Update Banner — Implementation Spec

Claude Code prompt. Run from `~/armorclaw`. Read CLAUDE.md first for design system and hard stops.

---

## What to build

An amber banner in the Advanced view that appears when a newer version of OpenClaw is available. The user triggers the actual update from the existing command runner (the `update --dry-run` preset is already there). ArmorClaw never auto-updates OpenClaw.

## Architecture (3 pieces)

### 1. Version checker module — NEW FILE: `wrapper/dashboard/openclaw-version-check.ts`

Server-side module imported by `server.ts`. No browser code.

```typescript
interface OpenClawVersionStatus {
  hasUpdate: boolean;
  installedVersion: string; // from `openclaw --version`
  latestVersion: string; // from releases.atom
  releaseUrl: string; // link to the release on GitHub
  lastChecked: string; // ISO 8601
  error: string | null; // if check failed, explain why
}
```

Behavior:

- `checkOpenClawVersion()`: Fetches `https://github.com/openclaw/openclaw/releases.atom`, parses the Atom XML to extract the latest release version from the first `<entry><title>` tag. Gets installed version by running `openclaw --version` via the same node/execSync pattern used in the run-command endpoint. Compares using semver (import from `node:` or use a simple major.minor.patch comparison — no new dependency). Caches the result in memory.
- `getOpenClawVersionStatus()`: Returns cached `OpenClawVersionStatus`. If no check has been done yet, returns `{ hasUpdate: false, installedVersion: '', latestVersion: '', releaseUrl: '', lastChecked: '', error: null }`.
- `startVersionCheckInterval()`: Starts a `setInterval` that calls `checkOpenClawVersion()` every 6 hours. Also does an immediate check on first call. Call this once from server startup.
- On fetch failure (network error, parse error): set `error` field, keep `hasUpdate: false`. Never throw. Never crash the server.
- The installed version check needs `ARMORCLAW_REPO_ROOT` and `ARMORCLAW_NODE_PATH` from `process.env` (same as the existing run-command endpoint). If not set, set error and return gracefully.

Version comparison notes:

- The atom feed title might be like "v1.2.3" or "1.2.3" — strip the leading "v" before comparing.
- Use a simple semver compare: split on dots, compare major/minor/patch as numbers. Don't add a semver library.

### 2. API endpoint — ADD TO: `wrapper/dashboard/server.ts`

Add one new GET endpoint in the Advanced settings section (near the other `/api/advanced/*` endpoints):

```
GET /api/advanced/openclaw-update
```

Response:

```json
{
  "ok": true,
  "hasUpdate": true,
  "installedVersion": "1.2.0",
  "latestVersion": "1.3.1",
  "releaseUrl": "https://github.com/openclaw/openclaw/releases/tag/v1.3.1",
  "lastChecked": "2026-04-13T14:30:00.000Z",
  "error": null
}
```

Also call `startVersionCheckInterval()` from the server startup (wherever the Express app is initialized). Import from the new module.

### 3. Dashboard UI — EDIT: `wrapper/dashboard/public/index.html`

Add an amber update banner in the Advanced view's State B (gateway running), between the existing warning banner (`#advanced-warning`) and the backup toast (`#advanced-backup-toast`). Structure:

```html
<!-- OpenClaw update banner (hidden by default) -->
<div
  id="advanced-update-banner"
  style="display:none; padding:12px 16px; background:var(--ac-amber-light); border:0.5px solid var(--ac-amber); border-radius:8px; margin-bottom:12px; display:none;"
>
  <div style="display:flex; align-items:center; gap:12px;">
    <span style="font-size:13px; color:var(--ac-amber); flex:1;">
      OpenClaw <span id="advanced-update-version"></span> is available (you have
      <span id="advanced-update-current"></span>). Update from the command runner below, or
      <a
        id="advanced-update-link"
        href="#"
        target="_blank"
        rel="noopener"
        style="color:var(--ac-amber); text-decoration:underline;"
        >view the release</a
      >.
    </span>
    <button
      onclick="fillCmd('update')"
      class="btn-settings"
      type="button"
      style="font-size:12px; white-space:nowrap; border-color:var(--ac-amber); color:var(--ac-amber);"
    >
      Run update
    </button>
    <button
      onclick="dismissUpdateBanner()"
      type="button"
      style="background:none; border:none; cursor:pointer; color:var(--ac-amber); font-size:16px; padding:0 4px;"
    >
      &#10005;
    </button>
  </div>
</div>
```

JavaScript (add to the inline script):

```javascript
// ── OpenClaw update check ─────────────────────────────────────────
let _updateBannerDismissed = false;

async function checkOpenClawUpdate() {
  if (_updateBannerDismissed) return;
  try {
    const res = await fetch("/api/advanced/openclaw-update");
    const data = await res.json();
    const banner = document.getElementById("advanced-update-banner");
    if (data.hasUpdate && !_updateBannerDismissed) {
      document.getElementById("advanced-update-version").textContent = "v" + data.latestVersion;
      document.getElementById("advanced-update-current").textContent = "v" + data.installedVersion;
      document.getElementById("advanced-update-link").href = data.releaseUrl;
      banner.style.display = "block";
    } else {
      banner.style.display = "none";
    }
  } catch {
    // Silently ignore — not critical
  }
}

function dismissUpdateBanner() {
  _updateBannerDismissed = true;
  document.getElementById("advanced-update-banner").style.display = "none";
}
```

Call `checkOpenClawUpdate()` from inside `loadAdvancedView()` (the function that runs when the Advanced tab is selected). Put it after the existing `pollAdvancedGatewayStatus()` call. Don't add it to any polling interval — one check per tab visit is enough since the server caches the result for 6 hours anyway.

## Design system compliance

- Background: `var(--ac-amber-light)` (#2A1F0A)
- Border: `0.5px solid var(--ac-amber)` (#FFB347)
- Text: `color: var(--ac-amber)` — 13px Plus Jakarta Sans (inherits from body)
- No monospace in the banner text (it's user-facing)
- Button uses `btn-settings` class with amber border override (matches the existing config backup button pattern)
- Dismissible (X button), not persistent across page reloads (dismiss state is in-memory only, resets on reload)
- 12px border-radius, 12px margin-bottom (matches existing banners)
- Min tap target: the X button and "Run update" button both meet 44x44px

## What NOT to do

- Do not auto-update OpenClaw. The banner points to the command runner.
- Do not add a new npm dependency for semver parsing or XML parsing.
- Do not persist the version check result to disk.
- Do not add the banner to the Home view — Advanced view only.
- Do not use `console.log` — use `process.stderr.write` for debug logging if needed (matches existing server.ts pattern).
- Do not expose the releases.atom URL or any internal URLs to the dashboard client.

## Smoke test gate

After editing `index.html`, run `npm run test:smoke` before committing. This is a non-negotiable gate per CLAUDE.md.

## Files touched

1. NEW: `wrapper/dashboard/openclaw-version-check.ts`
2. EDIT: `wrapper/dashboard/server.ts` (import + endpoint + startup call)
3. EDIT: `wrapper/dashboard/public/index.html` (banner HTML + JS)

## Branch

`feature/openclaw-update-banner`
