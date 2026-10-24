#!/usr/bin/env node
/** Static settings review only: does not generate/read credentials or approve release. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VALIDATION_ID = 'dev.yumidang.validation';
export const VALIDATION_SCHEME = 'yumidang-validation';
const MODES = new Set(['source', 'validation', 'production']);
const FORBIDDEN_PERMISSIONS = ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'];
const androidAttribute = (text, name) => text.match(new RegExp(`android:${name}\\s*=\\s*["']([^"']+)["']`))?.[1];
const gradleValue = (text, name) => text.match(new RegExp(`^\\s*${name}\\s*(?:=\\s*)?["']([^"']+)["']`, 'm'))?.[1];

// Deliberately small parser for generated manifests, not a general XML validator.
// Reject unsupported declarations, malformed nesting and unresolved attributes rather
// than treating regex fragments/comments/queries as an Android receiver.
function manifestTree(xml) {
  const root = { name: '#document', attrs: {}, children: [] }, stack = [root];
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?xml[\s\S]*?\?>|<[^>"']*(?:"[^"]*"|'[^']*'|[^>"']*)*>|[^<]+/g) ?? [];
  if (tokens.join('') !== xml) return null;
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?xml')) continue;
    if (!token.startsWith('<')) { if (token.trim()) return null; continue; }
    const end = token.match(/^<\/([\w:.-]+)\s*>$/);
    if (end) { if (stack.length === 1 || stack.pop().name !== end[1]) return null; continue; }
    const start = token.match(/^<([\w:.-]+)([\s\S]*?)(\/?)>$/);
    if (!start) return null;
    const attrs = {}, body = start[2]; let offset = 0;
    const re = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    while (offset < body.length && body.slice(offset).trim()) {
      re.lastIndex = offset; const a = re.exec(body);
      if (!a || Object.hasOwn(attrs, a[1])) return null;
      attrs[a[1]] = a[2] ?? a[3]; offset = re.lastIndex;
    }
    const node = { name: start[1], attrs, children: [] };
    stack.at(-1).children.push(node); if (!start[3]) stack.push(node);
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.children[0].name !== 'manifest') return null;
  return root.children[0];
}
function callbackSchemes(xml, packageId) {
  const manifest = manifestTree(xml);
  if (!manifest || manifest.attrs['xmlns:android'] !== 'http://schemas.android.com/apk/res/android') return null;
  const apps = manifest.children.filter(n => n.name === 'application');
  if (apps.length !== 1) return null;
  const app = apps[0], names = new Set();
  const enabled = n => n.attrs['android:enabled'] === undefined || n.attrs['android:enabled'] === 'true';
  const fullName = name => !name ? null : name.startsWith('.') ? `${packageId}${name}` : name.includes('.') ? name : `${packageId}.${name}`;
  const activities = app.children.filter(n => n.name === 'activity');
  if (!enabled(app)) return [];
  for (const node of app.children) {
    if (!['activity', 'activity-alias'].includes(node.name) || !fullName(node.attrs['android:name']) || node.attrs['android:exported'] !== 'true' || !enabled(node)) continue;
    if (node.name === 'activity-alias') {
      const target = fullName(node.attrs['android:targetActivity']);
      const matches = activities.filter(a => fullName(a.attrs['android:name']) === target);
      if (!target || matches.length !== 1 || !enabled(matches[0]) || app.children.indexOf(matches[0]) >= app.children.indexOf(node)) continue;
    }
    for (const filter of node.children.filter(n => n.name === 'intent-filter')) {
      const has = (tag, value) => filter.children.some(n => n.name === tag && n.attrs['android:name'] === value);
      if (!has('action', 'android.intent.action.VIEW') || !has('category', 'android.intent.category.DEFAULT') || !has('category', 'android.intent.category.BROWSABLE')) continue;
      for (const data of filter.children.filter(n => n.name === 'data')) {
        const scheme = data.attrs['android:scheme'];
        if (scheme && /^[a-z][a-z0-9+.-]*$/.test(scheme)) names.add(scheme);
      }
    }
  }
  return [...names];
}

export function reviewAndroidSettings({ mode = 'source', config, manifest, gradle } = {}) {
  if (!MODES.has(mode)) throw new Error('mode must be source, validation, or production');
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok: Boolean(ok), message });
  const expo = config?.expo ?? config;
  const android = expo?.android ?? {};
  const schemes = typeof expo?.scheme === 'string' ? [expo.scheme] : expo?.scheme;
  add('config', expo && typeof expo === 'object' && typeof expo.name === 'string' && expo.name.trim(), 'Expo application configuration is present');
  add('version', typeof expo?.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(expo.version), 'Display version is a semantic version');
  add('version-code', android.versionCode === undefined || (Number.isSafeInteger(android.versionCode) && android.versionCode > 0), 'Configured Android versionCode must be a positive integer');
  add('package-format', android.package === undefined || (typeof android.package === 'string' && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/.test(android.package)), 'Configured package must have a valid application ID shape');
  add('schemes', Array.isArray(schemes) && schemes.length > 0 && schemes.every(s => typeof s === 'string' && /^[a-z][a-z0-9+.-]*$/.test(s)), 'Explicit valid application URL schemes are required');
  const picker = (expo?.plugins ?? []).filter(p => (Array.isArray(p) ? p[0] : p) === 'expo-image-picker');
  add('picker-permission-options', picker.length === 1 && Array.isArray(picker[0]) && picker[0][1]?.cameraPermission === false && picker[0][1]?.microphonePermission === false, 'Image picker explicitly disables camera and microphone permissions');
  const explicitPermissions = android.permissions ?? [];
  add('source-sensitive-permissions', Array.isArray(explicitPermissions) && !explicitPermissions.some(p => FORBIDDEN_PERMISSIONS.includes(p) || ['CAMERA', 'RECORD_AUDIO'].includes(p)), 'Source does not explicitly enable camera or microphone');
  add('source-cleartext', android.usesCleartextTraffic !== true, 'Source does not explicitly enable cleartext HTTP');
  if (mode === 'validation') {
    add('validation-identity', android.package === VALIDATION_ID && Array.isArray(schemes) && schemes.length === 1 && schemes[0] === VALIDATION_SCHEME, 'Validation identity is isolated from the production app');
    add('validation-version-code', Number.isSafeInteger(android.versionCode) && android.versionCode > 0, 'Validation configuration explicitly sets versionCode');
  }
  const generatedRequired = mode !== 'source';
  const suppliedGenerated = manifest !== undefined || gradle !== undefined;
  if (generatedRequired || suppliedGenerated) {
    add('generated-inputs', typeof manifest === 'string' && manifest.trim() && typeof gradle === 'string' && gradle.trim(), 'Both generated AndroidManifest.xml and app build.gradle are required');
    if (typeof manifest === 'string' && typeof gradle === 'string') {
      const applicationId = gradleValue(gradle, 'applicationId');
      const namespace = gradleValue(gradle, 'namespace');
      const versionName = gradleValue(gradle, 'versionName');
      const versionCode = Number(gradle.match(/^\s*versionCode\s*(?:=\s*)?(\d+)\b/m)?.[1]);
      add('generated-identity', typeof android.package === 'string' && applicationId === android.package && namespace === android.package, 'Generated applicationId and namespace match the resolved Expo configuration');
      add('generated-version', versionName === expo?.version && Number.isSafeInteger(versionCode) && versionCode > 0 && versionCode === android.versionCode, 'Generated versionName and versionCode match the resolved configuration');
      const permissionTags = [...manifest.matchAll(/<uses-permission\b[^>]*>/g)].map(m => m[0]);
      const permissions = permissionTags.filter(tag => !/tools:node\s*=\s*["']remove["']/.test(tag)).map(tag => androidAttribute(tag, 'name'));
      add('generated-sensitive-permissions', !permissions.some(p => FORBIDDEN_PERMISSIONS.includes(p)), 'Generated manifest does not enable camera or microphone');
      const application = manifest.match(/<application\b[^>]*>/)?.[0];
      add('generated-cleartext', Boolean(application) && androidAttribute(application, 'usesCleartextTraffic') !== 'true', 'Generated application does not explicitly allow cleartext HTTP; absence is not a network-security audit');
      const nativeSchemes = callbackSchemes(manifest, android.package);
      add('generated-schemes', Array.isArray(schemes) && nativeSchemes !== null && schemes.every(s => nativeSchemes.includes(s)), 'Configured schemes have an enabled exported VIEW/DEFAULT/BROWSABLE receiver; URI host/path and actual OAuth return remain unverified');
      if (mode === 'validation') {
        add('no-production-callback', nativeSchemes !== null && !nativeSchemes.includes('yumidang'), 'Validation manifest cannot receive the production yumidang callback');
      }
    }
  }
  const valid = checks.every(c => c.ok);
  return {
    mode,
    status: !valid ? 'FAIL' : mode === 'production' ? 'NOT_APPROVED' : 'PASS',
    checks,
    boundaries: {
      staticReviewOnly: true,
      productionApproval: 'NOT_APPROVED',
      nativeBuildExecuted: false,
      installExecuted: false,
      credentialsRead: false,
      credentialsCreated: false,
      externalAccountChanged: false,
    },
    remaining: ['Production application ID and prior Play registration history require team confirmation', 'Signing/upload-key ownership, custody and rotation require a separate approved process', 'Static settings cannot prove signing, installation, OAuth return or store readiness'],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!['--mode', '--config', '--manifest', '--gradle'].includes(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Usage: --mode source|validation|production --config FILE [--manifest FILE --gradle FILE]');
    if (name in options) throw new Error(`Duplicate argument: ${name}`);
    options[name] = argv[i + 1];
  }
  if (!options['--config']) throw new Error('--config is required; use an Expo config JSON export, never a credential file');
  const config = JSON.parse(await readFile(options['--config'], 'utf8'));
  const manifest = options['--manifest'] ? await readFile(options['--manifest'], 'utf8') : undefined;
  const gradle = options['--gradle'] ? await readFile(options['--gradle'], 'utf8') : undefined;
  const result = reviewAndroidSettings({ mode: options['--mode'], config, manifest, gradle });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'PASS' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    // Do not echo supplied file contents or credential-bearing data on parse errors.
    process.stderr.write(`Android settings review failed (${error?.code ?? error?.name ?? 'Error'}). Check input paths and JSON format.\n`);
    process.exitCode = 1;
  });
}
