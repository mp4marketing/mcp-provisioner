# mcp-provisioner

Workstream D of `TheEmpireGroupMCP`'s
[`docs/planning/18-mcp-admin-api-dual-control-plan.md`](https://github.com/mp4marketing/TheEmpireGroupMCP/blob/main/docs/planning/18-mcp-admin-api-dual-control-plan.md):
dual-controlled provisioning of MCP principals (per-human Postgres logins),
so `access-admin` can grant/revoke MCP access the same way it already does
for `reporting-hub`, without a human running
`TheEmpireGroupMCP/scripts/sync-principal-roles.mjs` by hand.

Two components, deliberately split across two different runtimes -- see doc
18's "Real architecture correction made mid-build" section for why:

- **`mcp-provisioner-api/`** -- a Cloudflare Worker, reachable ONLY via a
  Service Binding from `access-admin` (no public routes, ever). Unprivileged:
  `INSERT`/a narrow `UPDATE` on `mcp_admin.provisioning_queue`, nothing else.
  No `CREATEROLE` connection anywhere in this component. Its own Postgres
  connection is plaintext -- an accepted, named gap (doc 18), since its
  Service-Binding-only reachability is itself a real mitigation a public
  relay wouldn't add anything to for this data.
- **`supabase/functions/mcp-provisioner-poller/`** -- a Supabase Edge
  Function (Deno, real TLS), triggered every 5 minutes via `pg_cron`/`pg_net`
  (see `TheEmpireGroupMCP/migrations/mcp-provisioner/003_pg_cron_poller_schedule.sql`).
  The ONLY component in the whole system holding `CREATEROLE` +
  `vault.create_secret` -- it is what actually creates/rotates/disables a
  principal's Postgres login, after re-deriving the effective grant from
  `access.*`/the registry and requiring an exact match against the approved
  payload (doc 18 decision 10).

Both import the provisioning/approval logic from
[`@mp4marketing/mcp-provisioning`](https://github.com/mp4marketing/mcp-provisioning)
and [`@mp4marketing/dual-control`](https://github.com/mp4marketing/dual-control)
rather than reimplementing either.

## Prerequisites (not yet applied)

`TheEmpireGroupMCP/migrations/mcp-provisioner/001-003` -- the
`mcp_admin.provisioning_queue` table, the two new Postgres roles
(`mcp_provisioner_api`, `mcp_provisioner`), and the `pg_cron` schedule. These
create a `CREATEROLE`-holding role and need a manual review before running;
see that repo's own commit history for the full reasoning.

## Testing

- `npm test` (root) -- the poller's shared marker-recomputation logic
  (`supabase/functions/_shared/marker-logic.js`), via plain `node --test`
  (same reason `mcp-postgres-relay`'s shared modules are real `.js` files,
  not `.ts` -- Node's test runner can't import `.ts` without a loader, and
  this logic has no real TypeScript syntax to lose by being `.js`).
- `cd mcp-provisioner-api && npm test` -- the Worker's route logic (vitest,
  mocked `query` adapter, asserting exact SQL/params -- not behavioral
  simulation).

Both need `NODE_AUTH_TOKEN` (a GitHub token with read access to this org's
packages) set before `npm install`, since `@mp4marketing/mcp-provisioning`/
`@mp4marketing/dual-control` are GitHub Packages -- public repos, but GitHub
Packages still requires auth to install regardless of source visibility.

## Deploy

- `mcp-provisioner-api`: `cd mcp-provisioner-api && wrangler deploy` --
  manual for now (no `CLOUDFLARE_API_TOKEN` is configured for this repo's CI
  yet; add one and wire a deploy job into `.github/workflows/api-ci.yml`
  once available).
- `mcp-provisioner-poller`: CI-driven on push to `main`
  (`.github/workflows/poller-deploy.yml`), matching `mcp-postgres-relay`'s
  pattern exactly -- needs `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`
  set as this repo's GitHub Actions secrets first.
