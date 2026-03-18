/**
 * Thin wrapper around keytar (system keychain) for secure credential storage.
 *
 * Adapters call getCredential / setCredential instead of using keytar directly.
 * This keeps keytar as a soft dependency — if it's unavailable the error is
 * descriptive, and tests can mock this module cleanly.
 *
 * Never logs credential values. Never returns them to the dashboard layer.
 */

// ── keytar interface ──────────────────────────────────────────────────────────

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

// Lazy-loaded once per process; null = unavailable.
let _keytar: KeytarLike | null | undefined = undefined;

async function loadKeytar(): Promise<KeytarLike | null> {
  if (_keytar !== undefined) {
    return _keytar;
  }
  try {
    _keytar = (await import("keytar")) as unknown as KeytarLike;
  } catch {
    _keytar = null;
  }
  return _keytar;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve a stored credential.
 *
 * @param service  Service identifier, e.g. "armorclaw-gmail".
 * @param account  Account identifier, e.g. "oauth-token".
 * @returns        The stored value, or null if not found.
 * @throws         When keytar is unavailable (native module not installed).
 */
export async function getCredential(service: string, account: string): Promise<string | null> {
  const kt = await loadKeytar();
  if (!kt) {
    throw new Error(
      `Credential store unavailable. Install keytar to enable secure token storage.\n` +
        `Service: ${service}, account: ${account}`,
    );
  }
  return kt.getPassword(service, account);
}

/**
 * Store a credential securely.
 *
 * @throws  When keytar is unavailable.
 */
export async function setCredential(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) {
    throw new Error(`Credential store unavailable. Install keytar to enable secure token storage.`);
  }
  await kt.setPassword(service, account, value);
}

/**
 * Remove a stored credential.
 *
 * @returns  true if the credential was found and deleted, false otherwise.
 * @throws   When keytar is unavailable.
 */
export async function deleteCredential(service: string, account: string): Promise<boolean> {
  const kt = await loadKeytar();
  if (!kt) {
    throw new Error(`Credential store unavailable. Install keytar to enable secure token storage.`);
  }
  return kt.deletePassword(service, account);
}

/** Reset the cached keytar reference. Intended for test isolation only. */
export function resetCredentialStoreForTesting(): void {
  _keytar = undefined;
}
