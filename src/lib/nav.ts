/**
 * Pure navigation helpers shared across the console sidebar, mobile app bar,
 * command palette, and legacy top navbar.
 *
 * Kept dependency-free so route-highlighting and active-item lookup are
 * unit-testable without rendering the React shell. Authorization is enforced
 * server-side, not by navigation visibility.
 */

/** A nav item is active on its own path and any nested path beneath it. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}

/** Find the navigation item matching the current pathname, if any. */
export function findActiveNavItem<T extends { href: string }>(
  items: readonly T[],
  pathname: string,
): T | undefined {
  return items.find((item) => isNavItemActive(pathname, item.href));
}
