import { BrowserWindow } from "electron";
import { logger } from "./logger";
import { getAppState, updateAppState } from "./repositories";

export function handleDeepLink(
  url: string,
  getMainWindow: () => BrowserWindow | null,
): void {
  logger.info(`Deep link received: ${url}`);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logger.warn(`Invalid deep link URL: ${url}`);
    return;
  }

  const route = parsed.hostname + parsed.pathname.replace(/\/$/, "");

  switch (route) {
    case "auth":
      handleAuthCallback(parsed, getMainWindow);
      break;
    case "billing/return":
      handleBillingReturn(parsed, getMainWindow);
      break;
    default:
      logger.warn(`Unknown deep link route: ${route}`);
  }
}

function handleAuthCallback(
  url: URL,
  getMainWindow: () => BrowserWindow | null,
): void {
  const token = url.searchParams.get("token");
  if (!token) {
    logger.warn("Auth deep link missing token parameter");
    return;
  }

  // TODO: POST token to license worker /auth/exchange to get JWT
  // For now, advance onboarding past email verification
  const state = getAppState();
  if (
    state.onboardingState === "email_sent" ||
    state.onboardingState === "email_verified"
  ) {
    updateAppState({ onboardingState: "email_verified" });
  }

  const win = getMainWindow();
  if (win) {
    win.webContents.send("deep-link:auth", { token });
    win.focus();
  }
}

function handleBillingReturn(
  url: URL,
  getMainWindow: () => BrowserWindow | null,
): void {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    logger.warn("Billing deep link missing session_id parameter");
    return;
  }

  // TODO: verify Checkout session with license worker, store JWT
  const state = getAppState();
  if (state.onboardingState === "payment_captured") {
    updateAppState({ onboardingState: "openclaw_ready" });
  }

  const win = getMainWindow();
  if (win) {
    win.webContents.send("deep-link:billing", { sessionId });
    win.focus();
  }
}
