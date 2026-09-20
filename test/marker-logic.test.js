import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCurrentMarkers, markersMatch, deriveSlugsFromMarkers } from '../supabase/functions/_shared/marker-logic.js';

const REGISTRY = [
  { slug: 'luna-vista', displayName: 'Luna Vista', ghlLocationId: 'locLunaVista', resmanPropertyId: null, schemas: ['crm', 'resman'] },
  { slug: 'green-empire', displayName: 'Green Empire', ghlLocationId: 'locGreenEmpire', resmanPropertyId: null, schemas: ['crm', 'jobber'] },
];

function mockQuery(responses) {
  let call = 0;
  return async () => responses[call++] ?? [];
}

test('computeCurrentMarkers: wildcard user gets the wildcard sentinel only', async () => {
  const query = mockQuery([[{ '?column?': 1 }], []]);
  const result = await computeCurrentMarkers(query, 'u1', REGISTRY);
  assert.deepEqual(result, { deny: false, markers: ['tenant_wildcard'] });
});

test('computeCurrentMarkers: tenant-scoped user gets exactly that tenant\'s markers', async () => {
  const query = mockQuery([[], [{ tenant_slug: 'luna-vista' }]]);
  const result = await computeCurrentMarkers(query, 'u1', REGISTRY);
  assert.equal(result.deny, false);
  assert.deepEqual(
    result.markers.slice().sort(),
    ['tenant_loc_locLunaVista', 'tenant_slug_luna-vista'].sort()
  );
});

test('computeCurrentMarkers: no wildcard and no tenant rows denies -- this is the "access removed since approval" case', async () => {
  const query = mockQuery([[], []]);
  const result = await computeCurrentMarkers(query, 'u1', REGISTRY);
  assert.equal(result.deny, true);
});

test('computeCurrentMarkers: an unknown slug in user_tenant_access denies via resolveTenantScope', async () => {
  const query = mockQuery([[], [{ tenant_slug: 'not-a-real-tenant' }]]);
  const result = await computeCurrentMarkers(query, 'u1', REGISTRY);
  assert.equal(result.deny, true);
});

test('markersMatch is order-independent', () => {
  assert.equal(markersMatch(['a', 'b'], ['b', 'a']), true);
  assert.equal(markersMatch(['a', 'b'], ['a']), false);
});

test('deriveSlugsFromMarkers maps a marker set back to its registry slugs', () => {
  const slugs = deriveSlugsFromMarkers(REGISTRY, ['tenant_loc_locLunaVista']);
  assert.deepEqual(slugs, ['luna-vista']);
});

test('deriveSlugsFromMarkers with markers spanning two tenants returns both slugs', () => {
  const slugs = deriveSlugsFromMarkers(REGISTRY, ['tenant_slug_luna-vista', 'tenant_slug_green-empire']).sort();
  assert.deepEqual(slugs, ['green-empire', 'luna-vista']);
});
