/** Policy for newly chosen passwords, separate from existing-password KDFs.
 * Unicode code points count toward the minimum; the existing UTF-16 ceiling
 * bounds request/KDF resources. Never trim or normalize the selected secret.
 */
export function isValidNewPasswordLength(password: unknown): password is string {
  if (typeof password !== "string" || password.length > 4096) return false;
  let codePoints = 0;
  for (const character of password) {
    // v3: reject control characters (including NUL). A NUL/control byte in
    // a secret may be truncated or reinterpreted differently by a future
    // native verifier or log sink; display names already reject this range.
    // The whole password is scanned (not just the first 12 code points).
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
    codePoints++;
  }
  return codePoints >= 12;
}
