#!/usr/bin/env node
// Copies @mp4marketing/mcp-provisioning's and @mp4marketing/dual-control's
// source into supabase/functions/_shared/, so mcp-provisioner-poller can
// import them as plain relative files instead of via `npm:` specifiers.
//
// WHY THIS EXISTS: same real, currently-unfixed Supabase CLI bug documented
// in mcp-postgres-relay's own scripts/vendor-pg-plan-guard.mjs
// (supabase/cli#4927, closed "not planned") -- `supabase functions deploy`'s
// Deno bundler cannot reliably resolve ANY private npm package during
// deploy, confirmed live 2026-09-20 against this exact function
// ("npm package '@mp4marketing/mcp-provisioning' does not exist", identical
// failure shape to the relay's). `postgres@3.4.4`'s own npm: import is
// unaffected -- it's on the public registry, not subject to this bug.
//
// THE FIX: same pattern as mcp-postgres-relay -- install both as ordinary
// dependencies via real npm (which DOES authenticate against
// npm.pkg.github.com correctly) and copy their already-resolved source in
// before `supabase functions deploy` runs. index.ts imports the copies via
// relative paths, never `npm:@mp4marketing/...`.
//
// mcp-provisioning is a MULTI-FILE package (index.js re-exports from
// sibling registry.js/access.js/credentials.js/provision.js) -- the whole
// src/ directory is copied, not just index.js, so those relative imports
// keep resolving inside the copy. dual-control is single-file.
//
// The versions pinned in package.json's dependencies are the one place
// this needs to stay in sync with TheEmpireGroupMCP's own package.json --
// run `npm run vendor` (this script) after bumping either, both locally
// and as a CI step immediately before every poller deploy.
import { cpSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const nodeModules = join(repoRoot, "node_modules", "@mp4marketing");
const sharedDir = join(repoRoot, "supabase", "functions", "_shared");

// mcp-provisioning: copy the whole src/ dir as _shared/mcp-provisioning/
const provisioningSrc = join(nodeModules, "mcp-provisioning", "src");
const provisioningDest = join(sharedDir, "mcp-provisioning");
mkdirSync(provisioningDest, { recursive: true });
for (const file of readdirSync(provisioningSrc)) {
  copyFileSync(join(provisioningSrc, file), join(provisioningDest, file));
}
console.log(`Vendored ${provisioningSrc}/* -> ${provisioningDest}/`);

// dual-control: single file, copy as _shared/dual-control.js
const dualControlSrc = join(nodeModules, "dual-control", "src", "index.js");
const dualControlDest = join(sharedDir, "dual-control.js");
copyFileSync(dualControlSrc, dualControlDest);
console.log(`Vendored ${dualControlSrc} -> ${dualControlDest}`);
