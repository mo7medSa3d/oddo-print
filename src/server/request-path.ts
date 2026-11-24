/** Use the same URL dot-segment normalization as Next's Web Request adapter. */
export function requestPath(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url, "http://gateway.invalid").pathname;
  } catch {
    return ""; // Next rejects malformed request targets.
  }
}
