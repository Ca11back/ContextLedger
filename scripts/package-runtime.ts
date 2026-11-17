import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { hash } from '../src/server/codec';

const argument = process.argv.indexOf('--output');
if (argument < 0 || !process.argv[argument + 1])
  throw new Error('Supply --output artifacts/version (must not exist)');
const destination = resolve(process.argv[argument + 1]!);
await mkdir(destination, { recursive: false });
await cp('dist', join(destination, 'dist'), { recursive: true });
await cp('server.ts', join(destination, 'server.ts'));
await cp('LICENSE', join(destination, 'LICENSE'));
await cp('deploy/Dockerfile.runtime', join(destination, 'Dockerfile'));
async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) => (e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)])),
    )
  ).flat();
}
const sources = [
  ...(await files('src')),
  'server.ts',
  'LICENSE',
  'package.json',
  'bun.lock',
  'rsbuild.config.ts',
  'scripts/client-boundary.ts',
  'biome.json',
  'tsconfig.json',
  'deploy/Dockerfile.runtime',
  'plugins/ca11back_contextledger/plugin.js',
];
const sourceEntries = await Promise.all(
  sources.sort().map(async (path) => [path, hash(await readFile(path))]),
);
const contents = await Promise.all(
  (await files(destination))
    .sort()
    .map(async (path) => [relative(destination, path), hash(await readFile(path))]),
);
const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
  version: string;
  packageManager: string;
};
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Package requires a stable version');
const manifest = {
  format: 1,
  version: pkg.version,
  runtime: pkg.packageManager,
  created_at: new Date().toISOString(),
  source_digest: hash(JSON.stringify(sourceEntries)),
  source_files: Object.fromEntries(sourceEntries),
  files: Object.fromEntries(contents),
  runtime_dependencies:
    'Bundled; only Bun and node builtins external. No install in runtime image.',
};
await writeFile(
  join(destination, 'artifact-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    destination,
    source_digest: manifest.source_digest,
    manifest_sha256: hash(JSON.stringify(manifest, null, 2) + '\n'),
  }),
);
