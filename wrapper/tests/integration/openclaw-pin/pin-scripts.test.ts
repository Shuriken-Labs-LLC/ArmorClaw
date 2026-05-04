/**
 * Integration tests for the OpenClaw upstream pin drift-check scripts.
 *
 * Each test sets up a temporary directory containing:
 *   - a bare repo acting as fake "upstream"
 *   - a working repo cloned from it, with check-pin.sh / bump-pin.sh /
 *     PATHS.json copied in under wrapper/security/openclaw-pin/
 *   - PINNED_SHA.txt pointing at the fake-upstream's first commit
 *
 * The scripts derive REPO_ROOT from BASH_SOURCE, so copying them into
 * `<tempdir>/wrapper/security/openclaw-pin/` is enough to redirect them
 * onto the synthetic repo.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const pinDir = path.join(repoRoot, "wrapper", "security", "openclaw-pin");

const checkScript = path.join(pinDir, "check-pin.sh");
const bumpScript = path.join(pinDir, "bump-pin.sh");
const pathsTemplate = path.join(pinDir, "PATHS.json");

const SIGNER_PRINCIPAL = "test-signer@armorclaw.test";
const PIN_TAG = "v-test-pin";
const NEW_TAG = "v-test-new";

interface SshKeypair {
  privateKeyPath: string;
  /** "ssh-ed25519 AAAA..." with no comment, ready for the allowed-signers line. */
  publicKeyLine: string;
}

interface Sandbox {
  root: string;
  upstream: string;
  pinnedSha: string;
  newSha: string;
  pinDir: string;
  signerKey: SshKeypair;
  /** The principal listed in UPSTREAM_KEYS.txt (so tests can swap it). */
  signerPrincipal: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function generateSshKeypair(root: string, name: string): SshKeypair {
  const privateKeyPath = path.join(root, `${name}-key`);
  execFileSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", `${name}@armorclaw.test`, "-f", privateKeyPath],
    { stdio: "ignore" },
  );
  const pubFile = readFileSync(`${privateKeyPath}.pub`, "utf8").trim();
  const [keyType, keyData] = pubFile.split(/\s+/);
  return { privateKeyPath, publicKeyLine: `${keyType} ${keyData}` };
}

function configureSshSigning(repoPath: string, key: SshKeypair): void {
  git(repoPath, ["config", "gpg.format", "ssh"]);
  git(repoPath, ["config", "user.signingkey", key.privateKeyPath]);
}

function writeAllowedSigners(filePath: string, principal: string, publicKeyLine: string): void {
  writeFileSync(filePath, `${principal} namespaces="git" ${publicKeyLine}\n`);
}

function setupSandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-pin-test-"));
  const upstream = path.join(root, "fake-upstream.git");
  const work = path.join(root, "work");

  // Bare upstream
  mkdirSync(upstream, { recursive: true });
  git(upstream, ["init", "--bare", "-b", "main"]);

  // Working repo
  git(root, ["clone", upstream, "work"]);
  git(work, ["config", "user.email", "test@armorclaw.test"]);
  git(work, ["config", "user.name", "Test User"]);

  // Synthetic SSH signing key for upstream tags. Configured before any tag
  // creation so signed tags use it by default.
  const signerKey = generateSshKeypair(root, "signer");
  configureSshSigning(work, signerKey);

  // Initial upstream commit: a small "OpenClaw-owned" tree.
  mkdirSync(path.join(work, "src"), { recursive: true });
  mkdirSync(path.join(work, "docs"), { recursive: true });
  mkdirSync(path.join(work, "wrapper"), { recursive: true });
  writeFileSync(path.join(work, "src", "version.ts"), "export const v = 1;\n");
  writeFileSync(path.join(work, "docs", "README.md"), "upstream docs\n");
  writeFileSync(path.join(work, "wrapper", "code.ts"), "ArmorClaw\n");
  writeFileSync(path.join(work, "vitest.config.ts"), "default upstream config\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-m", "initial upstream tree"]);
  git(work, ["push", "origin", "main"]);
  const pinnedSha = git(work, ["rev-parse", "HEAD"]);

  // Signed release tag at the pinned SHA — happy path for signature gate.
  git(work, ["tag", "-s", PIN_TAG, "-m", "test pin", pinnedSha]);
  git(work, ["push", "origin", PIN_TAG]);

  // Second upstream commit (used as bump target). Also signed, so default
  // bump-pin tests exercise the verified-signature code path.
  writeFileSync(path.join(work, "src", "version.ts"), "export const v = 2;\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-m", "bump version"]);
  git(work, ["push", "origin", "main"]);
  const newSha = git(work, ["rev-parse", "HEAD"]);
  git(work, ["tag", "-s", NEW_TAG, "-m", "bump target", newSha]);
  git(work, ["push", "origin", NEW_TAG]);

  // Reset working tree back to the pinned commit so HEAD == pin.
  git(work, ["reset", "--hard", pinnedSha]);

  // Stage the pin scripts inside the working repo. The scripts derive
  // REPO_ROOT as <script>/../../..  ->  $work.
  const sandboxPinDir = path.join(work, "wrapper", "security", "openclaw-pin");
  mkdirSync(sandboxPinDir, { recursive: true });
  cpSync(checkScript, path.join(sandboxPinDir, "check-pin.sh"));
  cpSync(bumpScript, path.join(sandboxPinDir, "bump-pin.sh"));
  cpSync(pathsTemplate, path.join(sandboxPinDir, "PATHS.json"));
  writeFileSync(path.join(sandboxPinDir, "PINNED_SHA.txt"), `${pinnedSha}\n`);
  writeFileSync(path.join(sandboxPinDir, "SYNC_LOG.md"), "# Sync log (test)\n");
  writeAllowedSigners(
    path.join(sandboxPinDir, "UPSTREAM_KEYS.txt"),
    SIGNER_PRINCIPAL,
    signerKey.publicKeyLine,
  );

  // Trim PATHS.json down to the synthetic tree.
  writeFileSync(
    path.join(sandboxPinDir, "PATHS.json"),
    JSON.stringify(
      {
        comment: "test fixture",
        armorclawPaths: ["wrapper/"],
        openclawPaths: ["src/", "docs/", "vitest.config.ts"],
        localModsPaths: ["vitest.config.ts"],
        ambiguousPathsToInvestigate: [],
      },
      null,
      2,
    ),
  );

  // Make the synthetic clone its own "upstream" so OPENCLAW_UPSTREAM_URL
  // resolves the pinned SHA without hitting GitHub.
  return {
    root,
    upstream,
    pinnedSha,
    newSha,
    pinDir: sandboxPinDir,
    signerKey,
    signerPrincipal: SIGNER_PRINCIPAL,
  };
}

/** Replace the tag at a SHA with an unsigned annotated tag (drops signature). */
function makeUnsignedTag(workTree: string, sha: string, tagName: string): void {
  git(workTree, ["tag", "-d", tagName]);
  git(workTree, ["tag", "-a", tagName, "-m", "unsigned", sha]);
}

/** Remove the tag at a SHA entirely (so the SHA is at an untagged commit). */
function removeTag(workTree: string, tagName: string): void {
  git(workTree, ["tag", "-d", tagName]);
}

/** Re-sign the tag at a SHA with a fresh key NOT in UPSTREAM_KEYS.txt. */
function resignWithUnknownKey(
  workTree: string,
  sandboxRoot: string,
  sha: string,
  tagName: string,
  message: string,
): void {
  const stranger = generateSshKeypair(sandboxRoot, "stranger");
  git(workTree, ["tag", "-d", tagName]);
  // Temporarily switch the signing key, sign, then restore the original.
  const originalKey = git(workTree, ["config", "--get", "user.signingkey"]);
  git(workTree, ["config", "user.signingkey", stranger.privateKeyPath]);
  git(workTree, ["tag", "-s", tagName, "-m", message, sha]);
  git(workTree, ["config", "user.signingkey", originalKey]);
}

function workTreeOf(sandbox: Sandbox): string {
  return path.dirname(path.dirname(path.dirname(sandbox.pinDir)));
}

function runCheck(
  sandbox: Sandbox,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [path.join(sandbox.pinDir, "check-pin.sh")], {
    env: {
      ...process.env,
      OPENCLAW_UPSTREAM_URL: sandbox.upstream,
      ...env,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runBump(
  sandbox: Sandbox,
  args: string[],
  reply: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [path.join(sandbox.pinDir, "bump-pin.sh"), ...args], {
    input: `${reply}\n`,
    env: {
      ...process.env,
      OPENCLAW_UPSTREAM_URL: sandbox.upstream,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("check-pin.sh", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = setupSandbox();
  });

  afterEach(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it("exits 0 when HEAD matches the pin", () => {
    const result = runCheck(sandbox);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw pin OK");
  });

  it("exits 1 when an enforced path drifts", () => {
    writeFileSync(path.join(sandbox.root, "work", "src", "version.ts"), "export const v = 999;\n");
    const result = runCheck(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DRIFT detected");
    expect(result.stderr).toContain("src/");
  });

  it("exits 0 when ALLOW_OPENCLAW_DRIFT=1 is set despite drift", () => {
    writeFileSync(path.join(sandbox.root, "work", "src", "version.ts"), "export const v = 999;\n");
    const result = runCheck(sandbox, { ALLOW_OPENCLAW_DRIFT: "1" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ALLOW_OPENCLAW_DRIFT=1 set");
  });

  it("exits 0 when drift is confined to localModsPaths", () => {
    writeFileSync(
      path.join(sandbox.root, "work", "vitest.config.ts"),
      "ArmorClaw-modified config\n",
    );
    const result = runCheck(sandbox);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw pin OK");
  });

  it("exits 0 when drift is confined to armorclawPaths", () => {
    writeFileSync(path.join(sandbox.root, "work", "wrapper", "code.ts"), "ArmorClaw change\n");
    const result = runCheck(sandbox);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw pin OK");
  });

  it("exits 2 when PINNED_SHA.txt is missing", () => {
    rmSync(path.join(sandbox.pinDir, "PINNED_SHA.txt"));
    const result = runCheck(sandbox);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pin file not found");
  });

  it("exits 2 when PINNED_SHA.txt is empty", () => {
    writeFileSync(path.join(sandbox.pinDir, "PINNED_SHA.txt"), "");
    const result = runCheck(sandbox);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("empty");
  });

  it("exits 2 when PATHS.json is malformed", () => {
    writeFileSync(path.join(sandbox.pinDir, "PATHS.json"), "{ not valid");
    const result = runCheck(sandbox);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Failed to parse PATHS.json");
  });

  it("exits 2 when ambiguousPathsToInvestigate is non-empty", () => {
    writeFileSync(
      path.join(sandbox.pinDir, "PATHS.json"),
      JSON.stringify({
        comment: "x",
        armorclawPaths: ["wrapper/"],
        openclawPaths: ["src/"],
        localModsPaths: [],
        ambiguousPathsToInvestigate: ["unknown/"],
      }),
    );
    const result = runCheck(sandbox);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ambiguousPathsToInvestigate is non-empty");
  });

  it("exits 2 when pinned SHA is unreachable", () => {
    writeFileSync(
      path.join(sandbox.pinDir, "PINNED_SHA.txt"),
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
    );
    const result = runCheck(sandbox);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot resolve pinned SHA");
  });
});

describe("bump-pin.sh", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = setupSandbox();
  });

  afterEach(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it("updates PINNED_SHA.txt and appends SYNC_LOG.md when user confirms", () => {
    const result = runBump(sandbox, [sandbox.newSha], "y");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Pin bumped");
    const newPin = execSync(`cat "${path.join(sandbox.pinDir, "PINNED_SHA.txt")}"`)
      .toString()
      .trim();
    expect(newPin).toBe(sandbox.newSha);
    const log = execSync(`cat "${path.join(sandbox.pinDir, "SYNC_LOG.md")}"`).toString();
    expect(log).toMatch(/## \d{4}-\d{2}-\d{2} — bump/);
    expect(log).toContain(sandbox.newSha);
    expect(log).toContain(sandbox.pinnedSha);
  });

  it("leaves pin and log unchanged when user declines", () => {
    const result = runBump(sandbox, [sandbox.newSha], "n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Aborted");
    const newPin = execSync(`cat "${path.join(sandbox.pinDir, "PINNED_SHA.txt")}"`)
      .toString()
      .trim();
    expect(newPin).toBe(sandbox.pinnedSha);
  });

  it("rejects malformed SHA input", () => {
    const result = runBump(sandbox, ["not-a-sha"], "y");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a valid git SHA");
  });

  it("rejects missing argument", () => {
    const result = runBump(sandbox, [], "y");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects SHA not present upstream", () => {
    const result = runBump(sandbox, ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], "y");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot resolve");
  });

  it("no-ops when already at the requested SHA", () => {
    const result = runBump(sandbox, [sandbox.pinnedSha], "y");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Pin already at");
  });
});

describe("check-pin.sh signature gate", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = setupSandbox();
  });

  afterEach(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it("logs verified-signature OK when the pin is at a signed tag", () => {
    const result = runCheck(sandbox);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw signature OK");
    expect(result.stdout).toContain(PIN_TAG);
  });

  it("exits 1 when the pinned SHA is at an untagged commit", () => {
    removeTag(workTreeOf(sandbox), PIN_TAG);
    const result = runCheck(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not at a tagged commit");
  });

  it("exits 0 with warning when ALLOW_UNSIGNED_PIN=1 bypasses the untagged case", () => {
    removeTag(workTreeOf(sandbox), PIN_TAG);
    const result = runCheck(sandbox, { ALLOW_UNSIGNED_PIN: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("ALLOW_UNSIGNED_PIN=1 set");
    expect(result.stdout).toContain("OpenClaw pin OK");
  });

  it("exits 1 when the tag is unsigned (annotated only)", () => {
    makeUnsignedTag(workTreeOf(sandbox), sandbox.pinnedSha, PIN_TAG);
    const result = runCheck(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("signature verification failed");
  });

  it("exits 0 with warning when ALLOW_UNSIGNED_PIN=1 bypasses an unsigned tag", () => {
    makeUnsignedTag(workTreeOf(sandbox), sandbox.pinnedSha, PIN_TAG);
    const result = runCheck(sandbox, { ALLOW_UNSIGNED_PIN: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("ALLOW_UNSIGNED_PIN=1 set");
  });

  it("exits 1 when the tag is signed by a key not in UPSTREAM_KEYS.txt", () => {
    resignWithUnknownKey(
      workTreeOf(sandbox),
      sandbox.root,
      sandbox.pinnedSha,
      PIN_TAG,
      "stranger pin",
    );
    const result = runCheck(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("signature verification failed");
  });

  it("exits 0 with warning when ALLOW_UNSIGNED_PIN=1 bypasses an unknown signer", () => {
    resignWithUnknownKey(
      workTreeOf(sandbox),
      sandbox.root,
      sandbox.pinnedSha,
      PIN_TAG,
      "stranger pin",
    );
    const result = runCheck(sandbox, { ALLOW_UNSIGNED_PIN: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("ALLOW_UNSIGNED_PIN=1 set");
  });

  it("exits 2 when UPSTREAM_KEYS.txt is missing", () => {
    rmSync(path.join(sandbox.pinDir, "UPSTREAM_KEYS.txt"));
    const result = runCheck(sandbox);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("UPSTREAM_KEYS.txt missing");
  });

  it("still enforces signature even when ALLOW_OPENCLAW_DRIFT=1 bypasses drift", () => {
    // Drift the working tree AND remove the signed tag. Drift override alone
    // must NOT silence the signature gate.
    writeFileSync(path.join(sandbox.root, "work", "src", "version.ts"), "drifted\n");
    removeTag(workTreeOf(sandbox), PIN_TAG);
    const result = runCheck(sandbox, { ALLOW_OPENCLAW_DRIFT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not at a tagged commit");
  });
});

describe("bump-pin.sh signature gate", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = setupSandbox();
  });

  afterEach(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it("records 'Verified' in SYNC_LOG when bumping to a signed tag", () => {
    const result = runBump(sandbox, [sandbox.newSha], "y");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Pin bumped");
    const log = readFileSync(path.join(sandbox.pinDir, "SYNC_LOG.md"), "utf8");
    expect(log).toContain("**Signature:** Verified via tag");
    expect(log).toContain(NEW_TAG);
  });

  it("refuses unsigned new SHA without ALLOW_UNSIGNED_PIN", () => {
    makeUnsignedTag(workTreeOf(sandbox), sandbox.newSha, NEW_TAG);
    const result = runBump(sandbox, [sandbox.newSha], "y");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("signature verification failed");
    // Pin file untouched on refusal.
    const pinAfter = readFileSync(path.join(sandbox.pinDir, "PINNED_SHA.txt"), "utf8").trim();
    expect(pinAfter).toBe(sandbox.pinnedSha);
  });

  it("refuses untagged new SHA without ALLOW_UNSIGNED_PIN", () => {
    removeTag(workTreeOf(sandbox), NEW_TAG);
    const result = runBump(sandbox, [sandbox.newSha], "y");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not at a tagged commit");
    const pinAfter = readFileSync(path.join(sandbox.pinDir, "PINNED_SHA.txt"), "utf8").trim();
    expect(pinAfter).toBe(sandbox.pinnedSha);
  });

  it("with ALLOW_UNSIGNED_PIN=1 + Notes reason: bump completes and SYNC_LOG records both UNVERIFIED and Notes", () => {
    removeTag(workTreeOf(sandbox), NEW_TAG);
    // Stdin sequence: Notes reason, then "y" for the proceed prompt.
    const result = spawnSync("bash", [path.join(sandbox.pinDir, "bump-pin.sh"), sandbox.newSha], {
      input: "in-flight upstream review, no tag yet\ny\n",
      env: {
        ...process.env,
        OPENCLAW_UPSTREAM_URL: sandbox.upstream,
        ALLOW_UNSIGNED_PIN: "1",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Pin bumped");
    const log = readFileSync(path.join(sandbox.pinDir, "SYNC_LOG.md"), "utf8");
    expect(log).toContain("**Signature:** UNVERIFIED");
    expect(log).toContain("untagged commit");
    expect(log).toContain("in-flight upstream review, no tag yet");
  });

  it("with ALLOW_UNSIGNED_PIN=1 but empty Notes reason: bump aborts", () => {
    removeTag(workTreeOf(sandbox), NEW_TAG);
    // Empty Notes line followed by EOF — bump should abort with exit 1
    // before reaching the proceed prompt.
    const result = spawnSync("bash", [path.join(sandbox.pinDir, "bump-pin.sh"), sandbox.newSha], {
      input: "\n",
      env: {
        ...process.env,
        OPENCLAW_UPSTREAM_URL: sandbox.upstream,
        ALLOW_UNSIGNED_PIN: "1",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Notes reason is required");
    const pinAfter = readFileSync(path.join(sandbox.pinDir, "PINNED_SHA.txt"), "utf8").trim();
    expect(pinAfter).toBe(sandbox.pinnedSha);
  });

  it("exits 2 when UPSTREAM_KEYS.txt is missing", () => {
    rmSync(path.join(sandbox.pinDir, "UPSTREAM_KEYS.txt"));
    const result = runBump(sandbox, [sandbox.newSha], "y");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("UPSTREAM_KEYS.txt missing");
  });

  it("refuses an unknown-signer tag without ALLOW_UNSIGNED_PIN", () => {
    resignWithUnknownKey(workTreeOf(sandbox), sandbox.root, sandbox.newSha, NEW_TAG, "stranger");
    const result = runBump(sandbox, [sandbox.newSha], "y");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("signature verification failed");
  });
});
