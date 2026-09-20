// mcp-provisioner-poller -- the ONE component in the whole system holding
// CREATEROLE + vault.create_secret. A Supabase Edge Function (real TLS via
// Deno), not a Cloudflare Worker, per TheEmpireGroupMCP's
// docs/planning/18-mcp-admin-api-dual-control-plan.md Workstream D's
// architecture correction. Triggered on a schedule via pg_cron/pg_net (see
// that repo's migrations/mcp-provisioner/003_pg_cron_poller_schedule.sql),
// NOT by any external client -- unlike mcp-postgres-relay, this function's
// only legitimate caller is Postgres's own scheduler, so it has no
// X-Relay-Auth/JWT scheme of its own. Deployed WITHOUT --no-verify-jwt;
// pg_cron authenticates with the service_role key against Supabase's own
// platform gate, the same outer defense-in-depth layer the relay keeps.
//
// HARD RULE, same as mcp-postgres-relay: never log the request/response
// body, a connection string, a password, or any error object that could
// serialize either.
import postgres from "npm:postgres@3.4.4";
import {
  TENANT_REGISTRY_SELECT,
  normalizeRegistryRows,
  dbRoleForUserId,
  secretNameForUserId,
  provisionPrincipal,
  deprovisionPrincipal,
  quoteRoleName,
} from "npm:@mp4marketing/mcp-provisioning@0.1.0";
import { claimApprovedRows, markProcessed, markStale } from "npm:@mp4marketing/dual-control@0.1.0";
import { computeCurrentMarkers, markersMatch, deriveSlugsFromMarkers } from "../_shared/marker-logic.js";

const QUEUE_TABLE = "mcp_admin.provisioning_queue";
const INTERNAL_TIMEOUT_MS = 20_000;
const SQL_END_TIMEOUT_S = 2;
const CLAIM_LIMIT = 10;

type TxSql = ReturnType<typeof postgres>;
type Registry = ReturnType<typeof normalizeRegistryRows>;

function asQuery(sql: TxSql) {
  return (text: string, params?: unknown[]) => sql.unsafe(text, (params ?? []) as never);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function isLiveAdmin(txSql: TxSql, userId: string | null): Promise<boolean> {
  if (userId === null) return true; // revoke rows leave approved_by NULL by design (doc 18 D.2)
  const rows = await txSql`SELECT 1 FROM access.admin_panel_users WHERE user_id = ${userId} AND revoked_at IS NULL`;
  return rows.length > 0;
}

async function processGrantRow(txSql: TxSql, row: Record<string, unknown>, registry: Registry): Promise<"processed" | "stale"> {
  const userId = row.user_id as string;
  const approvedMarkers = row.tenant_markers as string[];

  const current = await computeCurrentMarkers(asQuery(txSql), userId, registry);
  if (current.deny || !markersMatch(current.markers, approvedMarkers)) {
    return "stale";
  }

  const role = dbRoleForUserId(userId);
  const roleExistsRows = await txSql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
  const roleExists = roleExistsRows.length > 0;
  const desiredRoles = new Set(["mcp_data_reader", ...current.markers]);

  await provisionPrincipal(asQuery(txSql), {
    role,
    roleExists,
    secretName: secretNameForUserId(userId),
    secretDescription: "TheEmpireGroupMCP per-principal Postgres password (provisioned via mcp-provisioner-poller)",
    desiredRoles,
    quoteRoleName,
  });

  // Doc 18 decision D.5: the poller is the one thing that writes
  // access.user_product_access -- MCP's own eligibility table, which
  // resolvePrincipal()/sync-principal-roles.mjs read on every call/sync.
  // Wildcard -> one unrestricted row (tenant_slug NULL); otherwise one row
  // per tenant slug this grant covers. Upsert-shaped: revive a
  // previously-revoked row rather than leaving a duplicate.
  const grantedSlugs = current.markers.includes("tenant_wildcard") ? [null] : deriveSlugsFromMarkers(registry, current.markers);
  for (const slug of grantedSlugs) {
    await txSql`
      INSERT INTO access.user_product_access (user_id, product, tenant_slug, revoked_at)
      VALUES (${userId}, 'mcp', ${slug}, NULL)
      ON CONFLICT (user_id, product, tenant_slug)
      DO UPDATE SET revoked_at = NULL`;
  }

  return "processed";
}

async function processRevokeRow(txSql: TxSql, row: Record<string, unknown>): Promise<"processed"> {
  const userId = row.user_id as string;
  const role = dbRoleForUserId(userId);
  const roleExistsRows = await txSql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
  if (roleExistsRows.length > 0) {
    await deprovisionPrincipal(asQuery(txSql), { role, quoteRoleName });
  }
  await txSql`
    UPDATE access.user_product_access
       SET revoked_at = now()
     WHERE user_id = ${userId} AND product = 'mcp' AND revoked_at IS NULL`;
  return "processed";
}

Deno.serve(async (_req: Request) => {
  const client = postgres({
    host: "db.svjemxaceebvuutpoixk.supabase.co",
    port: 5432,
    database: "postgres",
    username: "mcp_provisioner",
    password: Deno.env.get("MCP_PROVISIONER_DB_PASSWORD")!,
    ssl: "require",
    max: 1,
    connect_timeout: 8,
    connection: { application_name: "mcp-provisioner-poller" },
  });

  const summary = { claimed: 0, processed: 0, stale: 0, errors: 0 };

  try {
    await withTimeout(
      client.begin(async (txSql) => {
        const registry = normalizeRegistryRows(await txSql.unsafe(TENANT_REGISTRY_SELECT));
        const claimed = await claimApprovedRows(asQuery(txSql), QUEUE_TABLE, { limit: CLAIM_LIMIT });
        summary.claimed = claimed.length;

        for (const row of claimed) {
          const requestedByLive = await isLiveAdmin(txSql, row.requested_by as string);
          const approvedByLive = await isLiveAdmin(txSql, (row.approved_by as string) ?? null);
          if (!requestedByLive || !approvedByLive) {
            await markStale(asQuery(txSql), QUEUE_TABLE, { id: row.id });
            summary.stale++;
            continue;
          }

          try {
            // Each row runs inside its OWN savepoint, not bare statements
            // against the outer transaction. A SQL error inside one row
            // (e.g. a concurrent DDL conflict) would otherwise leave the
            // whole outer sql.begin() transaction aborted -- Postgres
            // refuses every subsequent statement in an aborted transaction
            // block until a ROLLBACK -- which would silently fail every
            // OTHER claimed row in this same run too, not just the bad one.
            // sql.savepoint() issues SAVEPOINT/ROLLBACK TO SAVEPOINT for us
            // on a thrown error, isolating the failure to this row alone.
            await txSql.savepoint(async (sp) => {
              const outcome =
                row.action_type === "revoke"
                  ? await processRevokeRow(sp, row as Record<string, unknown>)
                  : await processGrantRow(sp, row as Record<string, unknown>, registry);

              if (outcome === "stale") {
                await markStale(asQuery(sp), QUEUE_TABLE, { id: row.id });
                summary.stale++;
              } else {
                await markProcessed(asQuery(sp), QUEUE_TABLE, { id: row.id });
                summary.processed++;
              }
            });
          } catch {
            // The savepoint's own rollback already undid this row's partial
            // work; it is left in 'processing' (its claim already flipped
            // it there, in the OUTER transaction, before this savepoint ran)
            // for the next run to reconsider -- never silently retried
            // within the same run.
            console.error("mcp-provisioner-poller: row failed, leaving in processing for next run", row.id);
            summary.errors++;
          }
        }
      }),
      INTERNAL_TIMEOUT_MS,
      "poller run"
    );
  } finally {
    // NOT a bare client.end() -- waits indefinitely instead of closing
    // (same correction as mcp-postgres-relay).
    await client.end({ timeout: SQL_END_TIMEOUT_S }).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, ...summary }), { headers: { "content-type": "application/json" } });
});
