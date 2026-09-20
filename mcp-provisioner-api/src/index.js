// mcp-provisioner-api -- unprivileged. Reachable ONLY via a Cloudflare
// Service Binding (no routes/custom domain in wrangler.jsonc), same pattern
// as reporting-hub's apps/admin. Holds INSERT + a narrow UPDATE on
// mcp_admin.provisioning_queue and nothing else -- no CREATEROLE connection
// anywhere in this Worker, ever (doc 18 decision 3/5).
//
// Auth: a shared secret header (MCP_PROVISIONER_SHARED_SECRET, deliberately
// a DIFFERENT value from ACCESS_ADMIN_SHARED_SECRET -- what leaking this one
// buys is role-creation-adjacent queue writes, not an ordinary row write)
// plus X-Acting-Admin-User-Id, mirroring access-admin's own
// reporting-hub-binding.ts call shape. The human-privilege check (fresh MFA,
// live admin_panel_users row) already happened once in access-admin, before
// this is ever called -- this Worker trusts the Service Binding boundary +
// the shared secret, it does not re-derive admin-ness itself.
import { withClient, buildConnectionString } from './db.js';
import {
  insertProvisioningRequest,
  approveProvisioningRequest,
  rejectProvisioningRequest,
  insertRevokeRequest,
  listUsers,
  listGrants,
} from './routes.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function checkAuth(request, env) {
  const secret = request.headers.get('X-Mcp-Provisioner-Secret');
  const actingAdminUserId = request.headers.get('X-Acting-Admin-User-Id');
  if (!env.MCP_PROVISIONER_SHARED_SECRET || secret !== env.MCP_PROVISIONER_SHARED_SECRET) {
    return { ok: false, response: json({ error: 'unauthorized' }, 401) };
  }
  if (!actingAdminUserId) {
    return { ok: false, response: json({ error: 'X-Acting-Admin-User-Id is required' }, 400) };
  }
  return { ok: true, actingAdminUserId };
}

export default {
  async fetch(request, env) {
    const auth = checkAuth(request, env);
    if (!auth.ok) return auth.response;
    const { actingAdminUserId } = auth;

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === 'POST' && pathname === '/provisioning') {
        const body = await request.json();
        return await withClient(buildConnectionString(env), async (q) => {
          const row = await insertProvisioningRequest(q, {
            userId: body.userId,
            tenantMarkers: body.tenantMarkers,
            requestedBy: actingAdminUserId,
          });
          return json(row, 201);
        });
      }

      const approveMatch = pathname.match(/^\/provisioning\/(\d+)\/approve$/);
      if (request.method === 'POST' && approveMatch) {
        return await withClient(buildConnectionString(env), async (q) => {
          const row = await approveProvisioningRequest(q, { id: Number(approveMatch[1]), approvedBy: actingAdminUserId });
          if (!row) return json({ error: 'already handled' }, 409);
          return json(row);
        });
      }

      const rejectMatch = pathname.match(/^\/provisioning\/(\d+)\/reject$/);
      if (request.method === 'POST' && rejectMatch) {
        return await withClient(buildConnectionString(env), async (q) => {
          const row = await rejectProvisioningRequest(q, { id: Number(rejectMatch[1]), rejectedBy: actingAdminUserId });
          if (!row) return json({ error: 'already handled' }, 409);
          return json(row);
        });
      }

      const revokeMatch = pathname.match(/^\/provisioning\/([0-9a-fA-F-]{36})$/);
      if (request.method === 'DELETE' && revokeMatch) {
        return await withClient(buildConnectionString(env), async (q) => {
          const row = await insertRevokeRequest(q, { userId: revokeMatch[1], requestedBy: actingAdminUserId });
          return json(row, 201);
        });
      }

      if (request.method === 'GET' && pathname === '/users') {
        return await withClient(buildConnectionString(env), async (q) => json(await listUsers(q)));
      }

      if (request.method === 'GET' && pathname === '/grants') {
        const userId = url.searchParams.get('userId') || undefined;
        return await withClient(buildConnectionString(env), async (q) => json(await listGrants(q, { userId })));
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      // Never echo err.message to the caller -- same "fixed categories only"
      // discipline as mcp-postgres-relay and TheEmpireGroupMCP's check_data.
      console.error('mcp-provisioner-api error:', err && err.message);
      return json({ error: 'request failed' }, 400);
    }
  },
};
