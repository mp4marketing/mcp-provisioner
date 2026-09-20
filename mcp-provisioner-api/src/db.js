// Plaintext Postgres connection for mcp-provisioner-api -- accepted, named
// gap per docs/planning/18 (TheEmpireGroupMCP) Workstream D's architecture
// correction: this Worker's own connection is NOT moved onto the TLS relay
// (mcp-postgres-relay), because its Service-Binding-only reachability (never
// a public URL) is itself a real structural mitigation a public relay
// wouldn't add anything to, and its data (queue table INSERT/narrow UPDATE
// only) is lower-stakes than a live Postgres password. Revisit if this
// Worker ever needs a public-facing path for any reason.
//
// Fresh pg.Client per call, closed in finally -- same connection-safety
// invariant as TheEmpireGroupMCP's src/db/with-client.js (connect() sits
// INSIDE the try whose finally calls end(), so a failed connect never leaks
// a socket).
import { Client } from 'pg';

const SESSION_POOLER_PORT = 5432;

export function buildConnectionString(env) {
  const host = env.SUPABASE_SESSION_POOLER_HOST;
  const ref = env.SUPABASE_PROJECT_REF;
  const password = env.MCP_PROVISIONER_API_DB_PASSWORD;
  if (!host || !ref || !password) {
    throw new Error('session pooler host / project ref / db password not configured');
  }
  const user = encodeURIComponent(`mcp_provisioner_api.${ref}`);
  const pass = encodeURIComponent(password);
  return `postgresql://${user}:${pass}@${host}:${SESSION_POOLER_PORT}/postgres`;
}

export async function withClient(connectionString, fn) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const q = async (text, params) => (await client.query(text, params)).rows;
    return await fn(q);
  } finally {
    await client.end().catch(() => {});
  }
}
