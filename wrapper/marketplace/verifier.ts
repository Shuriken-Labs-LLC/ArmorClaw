/**
 * ArmorClaw skill verifier — static analysis only.
 *
 * Accepts skill source code as a string and returns a structured report.
 * Never executes any code. No I/O. Fully synchronous and side-effect-free.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DangerousPatternMatch {
  label: string;
  severity: "danger" | "warning";
}

export interface VerifierReport {
  /** false when any danger-level pattern is present. */
  safe: boolean;
  dangerousPatterns: DangerousPatternMatch[];
  /** ArmorClaw permission levels declared in the source. */
  permissionsFound: string[];
  /** Hostnames found in URL literals in the source. */
  domainsFound: string[];
  /** Warning-level pattern labels (subset of dangerousPatterns). */
  warnings: string[];
  /** One-sentence plain-English summary for the dashboard UI. */
  summary: string;
}

// ── Known permission levels ───────────────────────────────────────────────────

const PERMISSION_LEVELS: ReadonlyArray<string> = [
  "read:files",
  "write:files",
  "read:email",
  "send:email",
  "read:calendar",
  "write:calendar",
  "read:crm",
  "write:crm",
  "browser:sandboxed",
  "network:outbound",
];

// ── Detection rules ───────────────────────────────────────────────────────────

interface Rule {
  pattern: RegExp;
  label: string;
  severity: "danger" | "warning";
}

const RULES: Rule[] = [
  // ── Danger ──
  {
    pattern: /\beval\s*\(/,
    label: "Dynamic code execution (eval)",
    severity: "danger",
  },
  {
    pattern: /\bnew\s+Function\s*\(/,
    label: "Dynamic code execution (Function constructor)",
    severity: "danger",
  },
  {
    pattern: /child_process/,
    label: "Shell command execution (child_process)",
    severity: "danger",
  },
  {
    pattern: /\bexecSync\s*\(|\bspawnSync\s*\(/,
    label: "Synchronous shell execution",
    severity: "danger",
  },
  {
    pattern: /process\.exit\s*\(/,
    label: "Process termination (process.exit)",
    severity: "danger",
  },
  {
    pattern: /__proto__\s*=/,
    label: "Prototype pollution (__proto__ assignment)",
    severity: "danger",
  },
  {
    pattern: /Object\.setPrototypeOf\s*\(/,
    label: "Prototype manipulation (Object.setPrototypeOf)",
    severity: "danger",
  },
  // ── Warning ──
  {
    pattern: /process\.env\b/,
    label: "Direct environment variable access (process.env)",
    severity: "warning",
  },
  {
    pattern: /from\s+['"`](?:node:)?fs['"`]|require\s*\(\s*['"`](?:node:)?fs['"`]\s*\)/,
    label: "Direct filesystem access (node:fs)",
    severity: "warning",
  },
  {
    pattern: /from\s+['"`](?:node:)?os['"`]|require\s*\(\s*['"`](?:node:)?os['"`]\s*\)/,
    label: "System information access (node:os)",
    severity: "warning",
  },
];

// ── Domain extractor ─────────────────────────────────────────────────────────

/** Extract unique hostnames from URL literals in source code. */
function extractDomains(code: string): string[] {
  const seen = new Set<string>();
  const re =
    /https?:\/\/([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    seen.add(m[1]);
  }
  return [...seen];
}

// ── Permission extractor ──────────────────────────────────────────────────────

/** Find which ArmorClaw permission levels appear as string literals in the code. */
function extractPermissions(code: string): string[] {
  return PERMISSION_LEVELS.filter(
    (level) => code.includes(`"${level}"`) || code.includes(`'${level}'`),
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run static analysis on skill source code.
 *
 * @param code  Raw source text of the skill file.
 * @returns     A {@link VerifierReport} — never throws.
 */
export function verifySkillSource(code: string): VerifierReport {
  const matched: DangerousPatternMatch[] = [];

  for (const rule of RULES) {
    if (rule.pattern.test(code)) {
      matched.push({ label: rule.label, severity: rule.severity });
    }
  }

  const hasDanger = matched.some((m) => m.severity === "danger");
  const warnings = matched.filter((m) => m.severity === "warning").map((m) => m.label);
  const perms = extractPermissions(code);
  const domains = extractDomains(code);

  // ── Build plain-English summary ──
  let summary: string;

  if (hasDanger) {
    const labels = matched
      .filter((m) => m.severity === "danger")
      .map((m) => m.label)
      .join("; ");
    summary = `Dangerous patterns detected: ${labels}.`;
  } else {
    const parts: string[] = [];
    if (domains.length > 0) {
      parts.push(
        `requests network access to ${domains.length} domain${domains.length !== 1 ? "s" : ""}`,
      );
    }
    if (perms.length > 0) {
      parts.push(`permission manifest declared: ${perms.join(", ")}`);
    }
    if (warnings.length > 0) {
      parts.push(`${warnings.length} advisory warning${warnings.length !== 1 ? "s" : ""}`);
    }
    summary =
      parts.length > 0
        ? `No dangerous patterns detected. This skill ${parts.join(". ")}.`
        : "No dangerous patterns detected. No permissions or network access declared.";
  }

  return {
    safe: !hasDanger,
    dangerousPatterns: matched,
    permissionsFound: perms,
    domainsFound: domains,
    warnings,
    summary,
  };
}
