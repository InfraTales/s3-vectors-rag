/**
 * Builds one self-contained index.js per Lambda function in build/<name>/, with the
 * AWS SDK clients inside. We pin the SDK version we tested instead of using whatever
 * version the Lambda runtime ships that week.
 */
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

const root = path.join(__dirname, '..');
export const FUNCTIONS = { ingest: 'ingest-handler.ts', query: 'query-handler.ts' } as const;

const meta: Record<string, unknown> = {};
for (const [name, entry] of Object.entries(FUNCTIONS)) {
  const outdir = path.join(root, 'build', name);
  rmSync(outdir, { recursive: true, force: true });
  const result = buildSync({
    entryPoints: [path.join(root, 'app', 'src', entry)],
    outfile: path.join(outdir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    sourcemap: true,
    legalComments: 'none',
    metafile: true,
  });
  meta[name] = result.metafile;
  const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
  console.log(`bundled build/${name}/index.js (${(bytes / 1024).toFixed(0)} KiB with source map)`);
}
// Kept outside the function folders so it isn't deployed. The bundle test reads it.
writeFileSync(path.join(root, 'build', 'meta.json'), JSON.stringify(meta));
