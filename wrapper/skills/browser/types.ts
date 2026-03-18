/**
 * Types for the browser automation skill.
 */

export type BrowserAction =
  | "navigate"
  | "fill-form"
  | "extract"
  | "screenshot"
  | "get-cookies"
  | "clear-cookies"
  | "allow-cookies";

export interface FormField {
  /** CSS selector for the input element. */
  selector: string;
  /** Value to fill. */
  value: string;
}

export interface BrowserInput {
  action: BrowserAction;
  /** Target URL — required for navigate, fill-form, extract, screenshot. */
  url?: string;
  /** Form fields for fill-form. */
  fields?: FormField[];
  /** CSS selector of the submit button or element to click after filling. */
  submitSelector?: string;
  /** CSS selector for extract. */
  selector?: string;
  /** HTML attribute to read in extract (defaults to textContent). */
  attribute?: string;
  /** Domain for allow-cookies / clear-cookies / get-cookies. */
  domain?: string;
  /** Wait for this selector to appear before returning (navigate/fill-form). */
  waitForSelector?: string;
}

export interface CookieInfo {
  name: string;
  domain: string;
  expires?: number;
}

export interface BrowserOutput {
  success: boolean;
  message: string;
  data?: {
    pageTitle?: string;
    pageUrl?: string;
    /** Extracted text or attribute values. */
    extracted?: string[];
    /** PNG screenshot encoded as base64. */
    screenshotBase64?: string;
    cookies?: CookieInfo[];
  };
}

/**
 * Browser adapter interface — injectable for testing.
 * All methods operate within the dedicated ArmorClaw browser profile.
 */
export interface IBrowserAdapter {
  /** Navigate to a URL and return the page title and final URL. */
  navigate(
    url: string,
    opts?: { waitForSelector?: string },
  ): Promise<{ title: string; url: string }>;

  /**
   * Navigate to `url`, fill the given form fields, optionally click a submit
   * element, and return the resulting page title and URL.
   */
  fillForm(
    url: string,
    fields: FormField[],
    opts?: { submitSelector?: string; waitForSelector?: string },
  ): Promise<{ title: string; url: string }>;

  /**
   * Navigate to `url` and return all matching values for `selector`.
   * When `attribute` is given, reads that attribute; otherwise reads textContent.
   */
  extract(url: string, selector: string, attribute?: string): Promise<string[]>;

  /** Navigate to `url` and return a PNG screenshot as a Buffer. */
  screenshot(url: string): Promise<Buffer>;

  /** Return stored cookies, optionally filtered by domain. */
  getCookies(domain?: string): Promise<CookieInfo[]>;

  /** Clear cookies, optionally for a specific domain only. */
  clearCookies(domain?: string): Promise<void>;

  /** Mark a domain as allowed for persistent cookie storage. */
  allowCookiesForDomain(domain: string): void;

  /** Release browser resources. */
  close(): Promise<void>;
}
