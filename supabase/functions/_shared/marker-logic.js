// Pure(ish) marker-recomputation logic for mcp-provisioner-poller, pulled
// into its own file (not inline in index.ts) so it can be imported
// byte-identical from BOTH the Deno Edge Function and a plain Node test --
// same reason mcp-postgres-relay's _shared/verify-request.js is a real .js
// file, not a .ts one (Node's --test runner can't import .ts without a
// loader). Depends on @mp4marketing/mcp-provisioning, a real dependency in
// both runtimes (npm: specifier in Deno, package.json in Node).
import { resolveTenantScope, markerRolesFor } from '@mp4marketing/mcp-provisioning';

/**
 * Doc 18 (TheEmpireGroupMCP's docs/planning/18-mcp-admin-api-dual-control-plan.md)
 * decision 10: recompute the effective grant from access.* / the registry,
 * independent of what the request itself submitted. Deliberately does NOT
 * read access.user_product_access -- that table is what a 'grant' action is
 * in the business of CREATING (a first-time grant has no live row there
 * yet, so filtering through it would always deny). What this recomputes
 * instead is "what would this user's CURRENT reporting-hub tenant scope
 * (access.staff_wildcard / user_tenant_access) authorize the MCP marker set
 * to be" -- if that scope was narrowed (or removed) between approval and
 * execution, this comes back with a smaller/denied set than what was
 * approved, and the caller's mismatch check marks the row stale instead of
 * granting something nobody currently has standing tenant access to.
 *
 * @param {(text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>} query
 * @param {string} userId
 * @param {Array<Record<string, unknown>>} registry - normalizeRegistryRows() output
 * @returns {Promise<{ deny: true, reason: string } | { deny: false, markers: string[] }>}
 */
export async function computeCurrentMarkers(query, userId, registry) {
  const [wildcardRows, tenantRows] = await Promise.all([
    query('SELECT 1 FROM access.staff_wildcard WHERE user_id = $1 AND revoked_at IS NULL', [userId]),
    query('SELECT tenant_slug FROM access.user_tenant_access WHERE user_id = $1 AND revoked_at IS NULL', [userId]),
  ]);
  const isWildcard = wildcardRows.length > 0;
  const tenantSlugs = tenantRows.map((r) => r.tenant_slug);
  const rawTenantScope = isWildcard ? ['*'] : tenantSlugs.length > 0 ? tenantSlugs : null;
  if (rawTenantScope === null) return { deny: true, reason: 'no live reporting-hub tenant scope at all' };
  const resolved = resolveTenantScope(rawTenantScope, registry);
  if (resolved.deny) return { deny: true, reason: resolved.reason ?? 'denied' };
  return { deny: false, markers: markerRolesFor(resolved, registry).slice().sort() };
}

/**
 * True iff two marker arrays are the same set (order-independent). Used to
 * compare the freshly-recomputed marker set against the exact payload that
 * was approved (doc 18 decision 10's "byte-for-byte" requirement).
 */
export function markersMatch(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/**
 * Reverse-maps a marker set back to the registry slugs it implies, so the
 * poller can write one access.user_product_access row per tenant_slug this
 * grant covers (doc 18 decision D.5). The registry has no direct
 * marker->slug index, so this derives it from markerRolesForTenant's own
 * naming convention (via markerRolesFor) rather than re-implementing it.
 */
export function deriveSlugsFromMarkers(registry, markers) {
  const slugs = new Set();
  for (const entry of registry) {
    const entryMarkers = markerRolesFor({ deny: false, wildcard: false, slugs: [entry.slug] }, registry);
    if (entryMarkers.some((m) => markers.includes(m))) slugs.add(entry.slug);
  }
  return [...slugs];
}
