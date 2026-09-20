// Pure route logic -- every function here takes a `query` adapter (the same
// shape @mp4marketing/dual-control expects) and plain args, so it can be
// unit-tested with a mocked query function asserting exact SQL/params,
// without spinning up a Worker runtime or a real Postgres connection.
//
// See TheEmpireGroupMCP's docs/planning/18-mcp-admin-api-dual-control-plan.md
// Workstream D.2 for the route inventory this implements.
import { requestAction, approveAction, rejectAction } from '@mp4marketing/dual-control';

export const QUEUE_TABLE = 'mcp_admin.provisioning_queue';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKER_NAME_RE = /^[a-zA-Z0-9_.-]{1,63}$/;

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

function assertMarkers(markers) {
  if (!Array.isArray(markers) || markers.length === 0) {
    throw new Error('tenantMarkers must be a non-empty array');
  }
  for (const m of markers) {
    if (typeof m !== 'string' || !MARKER_NAME_RE.test(m)) {
      throw new Error(`tenantMarkers contains an invalid marker name: ${String(m)}`);
    }
  }
}

/**
 * POST /provisioning -- insert a new grant request. Tier 2 (dual control),
 * per doc 18 decision 4: MCP's provisioning-queue approval is one of the
 * four actions dual control applies to.
 */
export async function insertProvisioningRequest(query, { userId, tenantMarkers, requestedBy }) {
  assertUuid(userId, 'userId');
  assertUuid(requestedBy, 'requestedBy');
  assertMarkers(tenantMarkers);
  return requestAction(query, QUEUE_TABLE, {
    tier: 2,
    requestedBy,
    extraColumns: {
      action_type: 'grant',
      user_id: userId,
      tenant_markers: JSON.stringify(tenantMarkers),
    },
  });
}

/** POST /provisioning/:id/approve -- delegates to @mp4marketing/dual-control. */
export async function approveProvisioningRequest(query, { id, approvedBy }) {
  assertUuid(approvedBy, 'approvedBy');
  return approveAction(query, QUEUE_TABLE, { id, approvedBy });
}

/** POST /provisioning/:id/reject -- single-control, no second admin needed. */
export async function rejectProvisioningRequest(query, { id, rejectedBy }) {
  assertUuid(rejectedBy, 'rejectedBy');
  return rejectAction(query, QUEUE_TABLE, { id, rejectedBy });
}

/**
 * DELETE /provisioning/:userId -- revoke. Per doc 18 D.2: inserted
 * PRE-APPROVED (status='approved' at insert), never through the dual-control
 * gate -- decision 4 makes revocation single-control. approved_by is left
 * NULL (not requestedBy) because the table's CHECK constraint requires
 * approved_by IS NULL OR approved_by <> requested_by; a revoke has no real
 * second approver, so "no approver" is the honest value, not a fabricated
 * self-approval.
 */
export async function insertRevokeRequest(query, { userId, requestedBy }) {
  assertUuid(userId, 'userId');
  assertUuid(requestedBy, 'requestedBy');
  const rows = await query(
    `INSERT INTO ${QUEUE_TABLE}
       (action_type, user_id, tenant_markers, tier, status, requested_by, approved_at)
     VALUES ('revoke', $1, '[]'::jsonb, 1, 'approved', $2, now())
     RETURNING *`,
    [userId, requestedBy]
  );
  return rows[0];
}

/** GET /users -- everyone with a live 'mcp' product row. */
export async function listUsers(query) {
  return query(
    `SELECT DISTINCT u.id, u.email
       FROM access.user_product_access p
       JOIN auth.users u ON u.id = p.user_id
      WHERE p.product = 'mcp' AND p.revoked_at IS NULL
      ORDER BY u.email`
  );
}

/** GET /grants[?userId=] -- live mcp product-access rows, optionally scoped to one user. */
export async function listGrants(query, { userId } = {}) {
  if (userId) {
    assertUuid(userId, 'userId');
    return query(
      `SELECT user_id, tenant_slug, revoked_at
         FROM access.user_product_access
        WHERE product = 'mcp' AND user_id = $1
        ORDER BY tenant_slug NULLS FIRST`,
      [userId]
    );
  }
  return query(
    `SELECT user_id, tenant_slug, revoked_at
       FROM access.user_product_access
      WHERE product = 'mcp'
      ORDER BY user_id, tenant_slug NULLS FIRST`
  );
}
