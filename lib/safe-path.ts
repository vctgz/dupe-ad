// Sanitize a post-login "next" redirect target to a safe, same-origin path.
//
// A prior pen test flagged the post-login redirect as an open-redirect vector
// (e.g. ?next=https://evil.example or ?next=//evil.example). We accept ONLY
// internal absolute paths: a single leading "/", not "//" or "/\" (protocol-
// relative), and no scheme. Anything else collapses to the safe default "/".
//
// Pure (no Node/Edge APIs) so it can run in the client LoginForm and in server
// components/route handlers alike.
export function safeInternalPath(input: string | null | undefined): string {
  if (!input) return "/";
  // Browsers (the WHATWG URL parser) strip ASCII tab (0x09), LF (0x0A), and CR
  // (0x0D) from ANYWHERE in a URL before parsing, so "/\t/evil.com" becomes
  // "//evil.com" (protocol-relative, cross-origin) at navigation time. Strip those
  // first, then validate AND return the cleaned string, so what we redirect to is
  // exactly what we checked.
  const cleaned = input.replace(/[\t\n\r]/g, "");
  // Must be an absolute, single-slash path.
  if (cleaned[0] !== "/") return "/";
  // Reject protocol-relative ("//host", "/\\host") which browsers treat as cross-origin.
  if (cleaned[1] === "/" || cleaned[1] === "\\") return "/";
  // Reject anything with a scheme or backslash trickery.
  if (cleaned.includes("://") || cleaned.includes("\\")) return "/";
  return cleaned;
}
