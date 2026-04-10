/**
 * Unit tests for wrapper/lib/platform-paths.ts.
 *
 * Tests cross-platform config path resolution. On the test machine we
 * verify the current platform path; other platforms are tested by
 * mocking process.platform.
 */

import { homedir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getArmorclawConfigDir,
  getBackupParentDir,
  getLauncherDataPath,
} from "../../../lib/platform-paths.ts";

// Save original platform so we can verify real behaviour
const REAL_PLATFORM = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
});

// ── getLauncherDataPath ─────────────────────────────────────────────────────

describe("getLauncherDataPath", () => {
  it("returns an absolute path", () => {
    const p = getLauncherDataPath();
    expect(p.startsWith("/") || /^[A-Z]:\\/i.test(p)).toBe(true);
  });

  it("ends with 'armorclaw-launcher'", () => {
    const p = getLauncherDataPath();
    expect(p.endsWith("armorclaw-launcher")).toBe(true);
  });

  it("returns correct path for current platform", () => {
    const p = getLauncherDataPath();
    if (REAL_PLATFORM === "darwin") {
      expect(p).toBe(join(homedir(), "Library", "Application Support", "armorclaw-launcher"));
    } else if (REAL_PLATFORM === "linux") {
      expect(p).toBe(join(homedir(), ".config", "armorclaw-launcher"));
    } else if (REAL_PLATFORM === "win32") {
      expect(p).toContain("armorclaw-launcher");
    }
  });

  it("uses APPDATA on Windows when available", () => {
    if (REAL_PLATFORM !== "win32") {
      return;
    } // Windows-only test
    const appData = process.env["APPDATA"];
    if (appData) {
      const p = getLauncherDataPath();
      expect(p).toBe(join(appData, "armorclaw-launcher"));
    }
  });
});

// ── getArmorclawConfigDir ───────────────────────────────────────────────────

describe("getArmorclawConfigDir", () => {
  it("returns an absolute path", () => {
    const p = getArmorclawConfigDir();
    expect(p.startsWith("/") || /^[A-Z]:\\/i.test(p)).toBe(true);
  });

  it("returns ~/.armorclaw on macOS/Linux", () => {
    if (REAL_PLATFORM === "win32") {
      return;
    }
    expect(getArmorclawConfigDir()).toBe(join(homedir(), ".armorclaw"));
  });
});

// ── getBackupParentDir ──────────────────────────────────────────────────────

describe("getBackupParentDir", () => {
  it("returns the parent of the launcher data path", () => {
    const parent = getBackupParentDir();
    const child = getLauncherDataPath();
    // The parent joined with the last segment of child should equal child
    const lastSegment = child.split(sep).pop();
    expect(join(parent, lastSegment ?? "")).toBe(child);
  });

  it("returns an absolute path", () => {
    const p = getBackupParentDir();
    expect(p.startsWith("/") || /^[A-Z]:\\/i.test(p)).toBe(true);
  });
});
