/**
 * Each function ships as one index.js with every dependency inside, including the
 * AWS SDK clients we tested against. Check that with esbuild's metafile, not a regex.
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { BUILD_DIR } from '../../infra/lib/rag-stack';

type Meta = Record<string, { outputs: Record<string, { imports: { path: string; external?: boolean }[] }>; inputs: Record<string, unknown> }>;
const meta = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'meta.json'), 'utf8')) as Meta;

test.each(['ingest', 'query'])('%s: index.js and its source map, nothing else', (name) => {
  expect(fs.readdirSync(path.join(BUILD_DIR, name)).sort()).toEqual(['index.js', 'index.js.map']);
});

test.each(['ingest', 'query'])('%s imports nothing outside Node.js itself', (name) => {
  const builtins = new Set(builtinModules);
  const external = Object.values(meta[name]!.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external)
    .map((i) => i.path.replace(/^node:/, ''))
    .filter((p) => !builtins.has(p));
  expect([...new Set(external)]).toEqual([]);
});

test('the S3 Vectors and Bedrock clients are inside the bundles', () => {
  const inputs = (name: string) => Object.keys(meta[name]!.inputs).join('\n');
  expect(inputs('ingest')).toContain('@aws-sdk/client-s3vectors');
  expect(inputs('ingest')).toContain('@aws-sdk/client-bedrock-runtime');
  expect(inputs('query')).toContain('@aws-sdk/client-s3vectors');
});

test.each([
  ['ingest', 'ingest-handler'],
  ['query', 'query-handler'],
])('%s loads in a clean Node.js process and exports handler', (name) => {
  // Load the real bundle with the env Lambda would set; a missing module or env var fails here.
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `const m=require(${JSON.stringify(path.join(BUILD_DIR, name, 'index.js'))});console.log(typeof m.handler)`], {
    env: {
      PATH: process.env.PATH,
      AWS_REGION: 'us-east-1',
      VECTOR_INDEX_ARN: 'arn:aws:s3vectors:us-east-1:123456789012:bucket/b/index/chunks',
      EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
      GENERATION_MODEL_ID: 'amazon.nova-micro-v1:0',
      MAX_DISTANCE: '0.6',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(out.trim()).toBe('function');
});

test('a bundle refuses to start without its config', () => {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const r = spawnSync(process.execPath, ['-e', `try{require(${JSON.stringify(path.join(BUILD_DIR, 'query', 'index.js'))})}catch(e){console.error(e.message);process.exit(1)}`], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Missing required environment variable VECTOR_INDEX_ARN');
});
