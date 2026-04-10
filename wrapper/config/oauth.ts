/**
 * OAuth provider configuration — reads credentials from environment variables.
 *
 * ArmorClaw ships with its own registered OAuth apps for Gmail/Google Calendar
 * and Microsoft 365. The client IDs and secrets are set via environment
 * variables — never hardcoded in source.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ OAuth scopes requested by ArmorClaw                                        │
 * ├──────────────┬──────────────────────────────────────────────────────────────┤
 * │ Google       │ https://mail.google.com/                                    │
 * │ (Gmail +     │   Full Gmail access: read, send, draft, label.              │
 * │  Calendar)   │ https://www.googleapis.com/auth/calendar                    │
 * │              │   Full Calendar access: read, create, modify events.        │
 * │              │                                                             │
 * │              │ access_type: offline (for refresh tokens)                   │
 * │              │ prompt: consent (forces re-consent to get refresh token)    │
 * ├──────────────┼──────────────────────────────────────────────────────────────┤
 * │ Microsoft    │ offline_access                                              │
 * │ (Outlook +   │   Enables refresh tokens for long-lived sessions.           │
 * │  Calendar)   │ Mail.Read                                                   │
 * │              │   Read the user's email.                                    │
 * │              │ Mail.Send                                                   │
 * │              │   Send mail on behalf of the user.                          │
 * │              │ Calendars.ReadWrite                                         │
 * │              │   Read, create, and modify calendar events.                 │
 * └──────────────┴──────────────────────────────────────────────────────────────┘
 *
 * Registration checklist
 * ──────────────────────
 * Google Cloud Console (https://console.cloud.google.com):
 *   1. Create OAuth 2.0 Client ID (Web application type)
 *   2. Add authorized redirect URI: http://localhost:7391/auth/google/callback
 *      (add ports 7392–7401 as well for fallback port support)
 *   3. Enable Gmail API and Google Calendar API
 *   4. Submit for OAuth verification to remove "unverified app" warning
 *   5. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env
 *
 * Azure Portal (https://portal.azure.com → App registrations):
 *   1. Register a new application (Accounts in any organizational directory
 *      and personal Microsoft accounts)
 *   2. Add redirect URI (Web): http://localhost:7391/auth/microsoft/callback
 *      (add ports 7392–7401 as well for fallback port support)
 *   3. Add API permissions: Mail.Read, Mail.Send, Calendars.ReadWrite
 *   4. Create a client secret under Certificates & secrets
 *   5. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET in .env
 */

// ── Scope constants ──────────────────────────────────────────────────────────

export const GOOGLE_OAUTH_SCOPES =
  "https://mail.google.com/ https://www.googleapis.com/auth/calendar";

export const MICROSOFT_OAUTH_SCOPES = "offline_access Mail.Read Mail.Send Calendars.ReadWrite";

// ── Credential reading ───────────────────────────────────────────────────────

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Read Google OAuth credentials from the environment.
 * Returns null if either variable is missing or empty.
 */
export function getGoogleOAuthCredentials(): OAuthCredentials | null {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"]?.trim();
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"]?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

/**
 * Read Microsoft OAuth credentials from the environment.
 * Returns null if either variable is missing or empty.
 */
export function getMicrosoftOAuthCredentials(): OAuthCredentials | null {
  const clientId = process.env["MICROSOFT_OAUTH_CLIENT_ID"]?.trim();
  const clientSecret = process.env["MICROSOFT_OAUTH_CLIENT_SECRET"]?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

// ── Startup validation ───────────────────────────────────────────────────────

export interface OAuthValidationResult {
  google: boolean;
  microsoft: boolean;
  errors: string[];
}

/**
 * Validate that OAuth credentials are configured.
 *
 * In production mode (NODE_ENV=production or ARMORCLAW_ENV=production),
 * missing credentials produce errors. In development mode, missing
 * credentials produce warnings only — the app still starts but email
 * features will be unavailable.
 */
export function validateOAuthConfig(): OAuthValidationResult {
  const isProduction =
    process.env["NODE_ENV"] === "production" || process.env["ARMORCLAW_ENV"] === "production";

  const errors: string[] = [];
  const google = getGoogleOAuthCredentials();
  const microsoft = getMicrosoftOAuthCredentials();

  if (!google) {
    const msg =
      "Gmail/Google Calendar is not configured. " +
      "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in your .env file.";
    if (isProduction) {
      errors.push(msg);
    }
  }

  if (!microsoft) {
    const msg =
      "Outlook/Microsoft 365 is not configured. " +
      "Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET in your .env file.";
    if (isProduction) {
      errors.push(msg);
    }
  }

  return {
    google: google !== null,
    microsoft: microsoft !== null,
    errors,
  };
}
