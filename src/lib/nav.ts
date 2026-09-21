/**
 * Pure navigation helper for the shared top navbar.
 *
 * Kept dependency-free so the section-highlighting rule is unit-testable
 * without rendering the React shell. Authorization is enforced server-side,
 * not by the navbar.
 */

/** A nav item is active on its own path and any nested path beneath it. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}
