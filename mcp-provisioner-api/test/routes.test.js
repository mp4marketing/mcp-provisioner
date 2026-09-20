import { describe, it, expect, vi } from 'vitest';
import {
  insertProvisioningRequest,
  approveProvisioningRequest,
  rejectProvisioningRequest,
  insertRevokeRequest,
  listProvisioningQueue,
  listUsers,
  listGrants,
  QUEUE_TABLE,
} from '../src/routes.js';

const USER_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const ADMIN_ID = 'ffffffff-eeee-4ddd-accc-bbbbbbbbbbbb';

describe('insertProvisioningRequest', () => {
  it('inserts a tier-2 pending row via dual-control requestAction, action_type=grant', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 1 }]);
    const row = await insertProvisioningRequest(query, {
      userId: USER_ID,
      tenantMarkers: ['tenant_slug_foo'],
      requestedBy: ADMIN_ID,
    });
    expect(row).toEqual({ id: 1 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`INSERT INTO ${QUEUE_TABLE}`);
    expect(params).toEqual([2, ADMIN_ID, 'pending', 'grant', USER_ID, JSON.stringify(['tenant_slug_foo'])]);
  });

  it('rejects a non-UUID userId before ever calling query', async () => {
    const query = vi.fn();
    await expect(
      insertProvisioningRequest(query, { userId: 'not-a-uuid', tenantMarkers: ['x'], requestedBy: ADMIN_ID })
    ).rejects.toThrow(/userId/);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an empty tenantMarkers array', async () => {
    const query = vi.fn();
    await expect(
      insertProvisioningRequest(query, { userId: USER_ID, tenantMarkers: [], requestedBy: ADMIN_ID })
    ).rejects.toThrow(/tenantMarkers/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('approveProvisioningRequest / rejectProvisioningRequest', () => {
  it('approve requires approvedBy <> requestedBy at the SQL level (delegated to dual-control)', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 1, status: 'approved' }]);
    const row = await approveProvisioningRequest(query, { id: 1, approvedBy: ADMIN_ID });
    expect(row.status).toBe('approved');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`UPDATE ${QUEUE_TABLE}`);
    expect(sql).toContain('requested_by <> $1');
    expect(params).toEqual([ADMIN_ID, 1]);
  });

  it('returns null (not an error) when the row was already handled', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const row = await approveProvisioningRequest(query, { id: 1, approvedBy: ADMIN_ID });
    expect(row).toBeNull();
  });

  it('reject is single-control -- no approvedBy<>requestedBy check in its SQL', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 1, status: 'rejected' }]);
    await rejectProvisioningRequest(query, { id: 1, rejectedBy: ADMIN_ID });
    const [sql] = query.mock.calls[0];
    expect(sql).not.toContain('requested_by <>');
    expect(sql).toContain("'rejected'");
  });
});

describe('insertRevokeRequest', () => {
  it('inserts a PRE-APPROVED row with approved_by left NULL, never dual-controlled', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 5, status: 'approved' }]);
    const row = await insertRevokeRequest(query, { userId: USER_ID, requestedBy: ADMIN_ID });
    expect(row.status).toBe('approved');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("'revoke'");
    expect(sql).toContain("'approved'");
    // approved_by column is never named/bound here -- the row relies on the
    // table's own default (NULL), satisfying the approver<>requester CHECK
    // without fabricating a self-approval.
    expect(sql).not.toMatch(/approved_by\s*,?\s*\)|,\s*approved_by\s*\)/i);
    expect(params).toEqual([USER_ID, ADMIN_ID]);
  });
});

describe('listUsers / listGrants', () => {
  it('listUsers scopes to live mcp product rows only', async () => {
    const query = vi.fn().mockResolvedValue([{ id: USER_ID, email: 'a@b.com' }]);
    const rows = await listUsers(query);
    expect(rows).toHaveLength(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("product = 'mcp'");
    expect(sql).toContain('revoked_at IS NULL');
  });

  it('listGrants scopes to one user when userId is given', async () => {
    const query = vi.fn().mockResolvedValue([]);
    await listGrants(query, { userId: USER_ID });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('user_id = $1');
    expect(params).toEqual([USER_ID]);
  });

  it('listGrants with no userId lists everyone', async () => {
    const query = vi.fn().mockResolvedValue([]);
    await listGrants(query);
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('user_id = $1');
    expect(params).toBeUndefined();
  });
});

describe('listProvisioningQueue', () => {
  it('scopes to pending/approved rows only, newest first', async () => {
    const query = vi.fn().mockResolvedValue([]);
    await listProvisioningQueue(query);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`FROM ${QUEUE_TABLE}`);
    expect(sql).toContain("status IN ('pending', 'approved')");
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toBeUndefined();
  });
});
