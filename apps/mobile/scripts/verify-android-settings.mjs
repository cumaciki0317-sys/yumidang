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
      const nativeSchemes = [...manifest.matchAll(/<data\b[^>]*>/g)].map(m => androidAttribute(m[0], 'scheme')).filter(Boolean);
      add('generated-schemes', Array.isArray(schemes) && schemes.every(s => nativeSchemes.includes(s)), 'Configured callback schemes are present in the generated manifest');
      if (mode === 'validation') {
        add('no-production-callback', !nativeSchemes.includes('yumidang'), 'Validation manifest cannot receive the production yumidang callback');
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
