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
  assert.equal((ci.match(new RegExp(officialMirrorOf(prodPostgres), 'g')) ?? []).length, 2);
  assert.ok(resilience.includes(officialMirrorOf(prodPostgres)));
});

test('Compose CLI selects the CI overlay without changing default production references', () => {
  assert.match(workflow, /COMPOSE_FILE: docker-compose\.yml:docker-compose\.ci\.yml/);
  assert.match(compose, /^\s*image:\s*postgres:16\.15-alpine@sha256:[0-9a-f]{64}$/m);
  assert.match(compose, /^\s*image:\s*caddy:2\.11\.4-alpine@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /^ARG NODE_BASE_IMAGE=node:24\.21\.0-alpine@sha256:[a-f0-9]{64}$/m);
});

test('CI uses the same reviewed image digests on ECR failure, without floating tags', () => {
  const reviewed = [
    'node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1',
    'postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
    'caddy:2.11.4-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e',
  ];
  for (const image of reviewed) {
    assert.ok(workflow.includes(`"${mirrorPrefix}${image}"`), `missing pinned mirror ${image}`);
  }
  assert.match(workflow, /if ! docker pull "\$image"; then/);
  assert.match(workflow, /grep -Fxq "postgres:16\.15-alpine@sha256:/);
  assert.match(workflow, /grep -Fxq "caddy:2\.11\.4-alpine@sha256:/);
  assert.match(workflow, /grep -Fq "ARG NODE_BASE_IMAGE=node:24\.21\.0-alpine@sha256:/);
  assert.match(workflow, /echo "COMPOSE_FILE=docker-compose\.yml" >> "\$GITHUB_ENV"/);
  assert.doesNotMatch(workflow, /docker pull (?:node|postgres|caddy):[^\s@]+(?:\s|$)/m);
});

test('Odoo CI has two registry origins pinned to the identical reviewed image digest', () => {
  const digest = 'sha256:144175ec0039d52daff1d79f7e51c9281ca3c98b96c830feb49d09764a9f5d7c';
  const ecr = `public.ecr.aws/docker/library/odoo:19.0@${digest}`;
  const hub = `docker.io/library/odoo:19.0@${digest}`;
  const candidatesLine = ci.split('\n').find(line => line.includes('for candidate in '));
  assert.ok(candidatesLine, 'image selection must be explicit');
  const refs = [...candidatesLine.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(refs, [ecr, hub], 'no floating tag or unexpected registry fallback');
  assert.equal(ci.split(ecr).length - 1, 1);
  assert.equal(ci.split(hub).length - 1, 1);
  assert.match(ci, /if docker pull "\$candidate"; then/);
  assert.match(ci, /odoo_image="\$candidate"/);
  assert.match(ci, /if \[ -z "\$odoo_image" \]; then\s*echo[^\n]+\n\s*exit 1/);
  assert.match(ci, /"\$odoo_image" \\/);
  assert.doesNotMatch(ci, /docker pull (?:odoo|docker\.io\/library\/odoo):19\.0(?:\s|$)/m);
});

test('all CI mirror image overrides remain immutable and reject mutable tags', () => {
  const ciRefs = [...ciCompose.matchAll(/^\s*(?:image|NODE_BASE_IMAGE):\s*(\S+)/gm)].map(m => m[1]);
  assert.equal(ciRefs.length, 4);
  for (const image of ciRefs) assert.match(image, /^public\.ecr\.aws\/docker\/library\/.+@sha256:[a-f0-9]{64}$/);
  assert.throws(() => officialMirrorOf('node:latest'), /sha256/);
});
