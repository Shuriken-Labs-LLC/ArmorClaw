/**
 * Dashboard navigation — sidebar/drawer nav and view switching.
 *
 * Depends on: NAV (constants.ts), activeView + advancedPollTimer (state.ts).
 * DOM-dependent: references document globals at runtime.
 * loadAdvancedView and advancedPollTimer remain inline until views/advanced.ts
 * is extracted; referenced here as browser globals via the declare stubs below.
 *
 * Canonical source for PR 3 of the dashboard JS extraction.
 *
 * SERIALISATION NOTE: Function.toString() is called on each export to emit
 * browser-runnable JS into /dashboard-lib.js. Keep function bodies plain JS —
 * no TS-specific syntax (no `as` casts, no generics, no non-null assertions).
 * Type annotations on parameters/return types are fine: Node's
 * experimental-strip-types removes them before .toString() is called.
 */

// ── Global stubs (browser globals, not emitted at runtime) ─────────────────

/* eslint-disable no-var */
declare var NAV: Array<{ id: string; icon: string; label: string }>;
declare var activeView: string;
declare var advancedPollTimer: ReturnType<typeof setInterval> | null;
declare function loadAdvancedView(): void;
/* eslint-enable no-var */

// ── Nav functions ───────────────────────────────────────────────────────────

/**
 * Build a nav group from the NAV constant into the given container element.
 * Uses <div role="button"> instead of <button> to prevent the browser UA
 * from injecting ButtonText system color — the persistent sidebar visibility bug.
 */
export function buildNav(containerId: string): void {
  const el = document.getElementById(containerId);
  if (!el) {
    return;
  }
  el.innerHTML = "";
  for (const item of NAV) {
    const btn = document.createElement("div");
    btn.className = "nav-item" + (item.id === activeView ? " active" : "");
    btn.dataset.view = item.id;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${item.label}</span>`;
    btn.addEventListener("click", () => {
      showView(item.id);
      closeDrawer();
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showView(item.id);
        closeDrawer();
      }
    });
    el.appendChild(btn);
  }
}

/**
 * Activate the named view: hide all others, update nav item active state,
 * start/stop Advanced view polling as appropriate.
 */
export function showView(id: string): void {
  activeView = id;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${id}`)?.classList.add("active");
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-view") === id);
  });
  if (id === "advanced") {
    loadAdvancedView();
  } else {
    if (advancedPollTimer) {
      clearInterval(advancedPollTimer);
      advancedPollTimer = null;
    }
  }
}

/** Open the mobile drawer nav. */
export function openDrawer(): void {
  document.getElementById("drawer")?.classList.add("open");
  document.getElementById("drawer-overlay")?.classList.add("open");
}

/** Close the mobile drawer nav. */
export function closeDrawer(): void {
  document.getElementById("drawer")?.classList.remove("open");
  document.getElementById("drawer-overlay")?.classList.remove("open");
}
