import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (path) => readFileSync(join(root, path), 'utf8');
const compose = load('docker-compose.yml');
const ciCompose = load('docker-compose.ci.yml');
const dockerfile = load('Dockerfile');
const workflow = load('.github/workflows/docker.yml');
const ci = load('.github/workflows/ci.yml');
const resilience = load('.github/workflows/security-supply-chain.yml');
const postgresHelper = load('scripts/ci-postgres.sh');
const mirrorPrefix = 'public.ecr.aws/docker/library/';

function officialMirrorOf(image) {
  // Every official image must name a stable release AND an immutable digest.
  assert.match(image, /^[a-z][a-z0-9-]*:[a-z0-9.\-]+@sha256:[a-f0-9]{64}$/);
  return mirrorPrefix + image;
}
function imageAfter(source, key) {
  const regex = new RegExp(`(?:^|\\n)\\s*${key}:\\s*([^\\s#]+)`);
  const match = source.match(regex);
  assert.ok(match, `image ${key} must exist`);
  return match[1];
}

const prodPostgres = imageAfter(compose, 'image');
const prodCaddy = compose.match(/^\s*image:\s*(caddy:[^\s#]+)$/m)?.[1];
const prodNode = dockerfile.match(/^ARG NODE_BASE_IMAGE=(node:[^\s#]+)$/m)?.[1];
assert.ok(prodCaddy && prodNode);

test('CI uses only exact-digest official ECR mirrors of reviewed production images', () => {
  assert.ok(ciCompose.includes(`image: ${officialMirrorOf(prodPostgres)}`));
  assert.ok(ciCompose.includes(`image: ${officialMirrorOf(prodCaddy)}`));
  assert.equal(ciCompose.split(`NODE_BASE_IMAGE: ${officialMirrorOf(prodNode)}`).length - 1, 2);
  assert.equal((dockerfile.match(/^FROM \$\{NODE_BASE_IMAGE\} AS /gm) ?? []).length, 4);
  assert.ok(postgresHelper.includes(officialMirrorOf(prodPostgres)));
  assert.ok(postgresHelper.includes('docker.io/library/' + prodPostgres));
  assert.ok(!ci.includes('    services:\\n      postgres:'));
  assert.ok(!resilience.includes('    services:\\n      postgres:'));
  assert.doesNotMatch(ci, /^    env:\n          POSTGRES_USER:/m);
  assert.doesNotMatch(resilience, /^    env:\n          POSTGRES_USER:/m);
  assert.equal(ci.split('run: bash scripts/ci-postgres.sh start').length - 1, 2);
  assert.equal(ci.split('run: bash scripts/ci-postgres.sh stop').length - 1, 2);
  assert.equal(resilience.split('run: bash scripts/ci-postgres.sh start').length - 1, 1);
  assert.equal(resilience.split('run: bash scripts/ci-postgres.sh stop').length - 1, 1);
  assert.ok(ci.includes('CI_PG_USER: odoo'));
  assert.ok(ci.includes('CI_PG_USER: postgres'));
  assert.ok(resilience.includes('CI_PG_USER: postgres'));
  assert.ok(postgresHelper.includes("127.0.0.1:5432:5432"));
  assert.match(postgresHelper, /if ! grep -Eqi '[^']*toomanyrequests[^']*rate exceeded[^']*429[^']*'/);
});

test('Compose CLI selects the CI overlay without changing default production references', () => {
  assert.match(workflow, /COMPOSE_FILE: docker-compose\.yml:docker-compose\.ci\.yml/);
  assert.match(compose, /^\s*image:\s*postgres:16\.15-alpine@sha256:[0-9a-f]{64}$/m);
  assert.match(compose, /^\s*image:\s*caddy:2\.11\.4-alpine@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /^ARG NODE_BASE_IMAGE=node:24\.21\.0-alpine@sha256:[a-f0-9]{64}$/m);
});

test('Odoo Community CI pulls the same immutable digest and uses Docker Hub only after throttling', () => {
  const tag = 'odoo:19.0@sha256:144175ec0039d52daff1d79f7e51c9281ca3c98b96c830feb49d09764a9f5d7c';
  const ecr = officialMirrorOf(tag);
  assert.ok(ci.includes(`odoo_image="${ecr}"`));
  assert.ok(ci.includes(`odoo_image="${tag}"`));
  // The selected image variable must be used for BOTH pull and test run.
  assert.ok(ci.includes('docker pull "$odoo_image"'));
  assert.ok(ci.includes('"$odoo_image" \\'));
  // No registry switch after a normal error; only 429 may activate fallback.
  assert.match(ci, /if ! grep -Eqi '[^']*toomanyrequests[^']*rate exceeded[^']*429[^']*'/);
  assert.equal(ci.includes('docker pull odoo:19.0@'), false);
});

test('all CI mirror image overrides remain immutable and reject mutable tags', () => {
  const ciRefs = [...ciCompose.matchAll(/^\s*(?:image|NODE_BASE_IMAGE):\s*(\S+)/gm)].map(m => m[1]);
  assert.equal(ciRefs.length, 4);
  for (const image of ciRefs) assert.match(image, /^public\.ecr\.aws\/docker\/library\/.+@sha256:[a-f0-9]{64}$/);
  assert.throws(() => officialMirrorOf('node:latest'), /sha256/);
});
