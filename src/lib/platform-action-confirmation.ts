/** Platform Owner has already chosen a concrete object in an authenticated UI.
 * The affirmative modal action is a boolean, never a manually typed database
 * identifier. Keep legacy exact confirmId for existing consumers.
 */
export function isPlatformActionConfirmed(
  value: { confirmed?: true; confirmId?: string }, resourceId: string,
): boolean {
  if (value.confirmId !== undefined && value.confirmId !== resourceId) return false;
  return value.confirmed === true || value.confirmId === resourceId;
}

export function platformActionReason(reason: string | undefined, action: string): string {
  return reason?.trim() || `Confirmed ${action} by Platform Owner`;
}
