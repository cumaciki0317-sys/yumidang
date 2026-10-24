#!/usr/bin/env node
/** Prepare a disposable preview-only Android build. Never builds, installs or signs a release. */
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALIDATION_ID, VALIDATION_SCHEME, reviewAndroidSettings } from './verify-android-settings.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(source, '../..');
const config = JSON.parse(await readFile(join(source, 'app.json'), 'utf8'));
const review = reviewAndroidSettings({ config });
if (review.status !== 'PASS') throw new Error('Source Android settings review failed');
// These IDs already belong to local validation; never infer production package/signing values.
config.expo.name = '유미당 내부 검증';
config.expo.android = { ...config.expo.android, package: VALIDATION_ID, versionCode: 1 };
config.expo.scheme = VALIDATION_SCHEME;
const dependencies = await realpath(join(source, 'node_modules'));
const root = await mkdtemp(join(tmpdir(), 'yumidang-android-validation-'));
const app = join(root, 'apps/mobile');
await mkdir(app, { recursive: true });
const hashes = {};
async function copyTree(relative) {
  const entries = await readdir(join(source, relative), { withFileTypes: true });
  await mkdir(join(app, relative), { recursive: true });
  for (const entry of entries) {
    const file = join(relative, entry.name);
    // Explicit allowlisted trees only; do not follow links into .env or credential directories.
    if (entry.isSymbolicLink()) throw new Error('Source tree symlinks are not allowed');
    if (entry.isDirectory()) await copyTree(file);
    else if (entry.isFile()) await copyFile(file);
  }
}
async function copyFile(file) {
  const bytes = await readFile(join(source, file));
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
  await cp(join(source, file), join(app, file));
  if (createHash('sha256').update(await readFile(join(app, file))).digest('hex') !== hashes[file]) throw new Error('Snapshot copy mismatch');
}
for (const tree of ['src', 'assets']) await copyTree(tree);
for (const file of ['package.json', 'package-lock.json', 'metro.config.js', 'tsconfig.json']) await copyFile(file);
await writeFile(join(app, 'app.json'), JSON.stringify(config, null, 2) + '\n');
await symlink(dependencies, join(app, 'node_modules'), 'dir');
// Shared read-only source dependency. No backend build or mutation is performed.
await symlink(join(repository, 'backend'), join(root, 'backend'), 'dir');
await writeFile(join(app, '.env'), 'EXPO_PUBLIC_DATA_MODE=preview\n');
const result = {
  root, app, source, packageId: VALIDATION_ID, scheme: VALIDATION_SCHEME,
  mode: 'preview', productionApproved: false, buildExecuted: false, installExecuted: false,
  credentialsCopied: false, sourceHashes: hashes,
  configSourceSha256: createHash('sha256').update(await readFile(join(source, 'app.json'))).digest('hex'),
  configSnapshotSha256: createHash('sha256').update(await readFile(join(app, 'app.json'))).digest('hex'),
  requiredEnvironment: { EXPO_PUBLIC_DATA_MODE: 'preview', EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', CI: '1' },
  prebuild: [process.execPath, join(dependencies, 'expo/bin/cli'), 'prebuild', '--platform', 'android', '--no-install', '--template', join(dependencies, 'expo/template.tgz')],
  limitations: ['No production signing or application ID decision', 'Preview data only; native authentication not connected', 'Dependencies and backend source linked from the reviewed checkout; do not mutate them during build', 'Generated project and APK must be validated separately'],
};
await writeFile(join(root, 'preparation.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
