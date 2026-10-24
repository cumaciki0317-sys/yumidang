import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reviewAndroidSettings, VALIDATION_ID, VALIDATION_SCHEME } from '../../apps/mobile/scripts/verify-android-settings.mjs';

const source = JSON.parse(await readFile(new URL('../../apps/mobile/app.json', import.meta.url), 'utf8'));
function fixture() {
  const config = structuredClone(source.expo);
  config.android.package = VALIDATION_ID;
  config.android.versionCode = 1;
  config.scheme = VALIDATION_SCHEME;
  return {
    mode: 'validation', config,
    manifest: `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/><application android:usesCleartextTraffic="false"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="${VALIDATION_SCHEME}"/></intent-filter></activity></application></manifest>`,
    gradle: `android {\n namespace '${VALIDATION_ID}'\n defaultConfig {\n applicationId '${VALIDATION_ID}'\n versionCode 1\n versionName '1.0.0'\n }\n}`,
  };
}
const fail = (input, id) => {
  const result = reviewAndroidSettings(input);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.checks.find(c => c.id === id)?.ok, false);
};
test('source review does not invent an Android package or production approval', () => {
  const result = reviewAndroidSettings({ mode: 'source', config: source });
  assert.equal(result.status, 'PASS');
  assert.equal(result.boundaries.productionApproval, 'NOT_APPROVED');
  assert.equal(source.expo.android.package, undefined);
});
test('isolated validation identity matches generated settings', () => {
  const result = reviewAndroidSettings(fixture());
  assert.equal(result.status, 'PASS');
  assert.equal(result.boundaries.credentialsRead, false);
  assert.equal(result.boundaries.nativeBuildExecuted, false);
});
test('validation refuses the production identity and callback', () => {
  const input = fixture(); input.config.scheme = 'yumidang'; input.config.android.package = 'com.example.yumidang';
  fail(input, 'validation-identity');
});
test('validation requires both generated artifacts', () => { const input = fixture(); delete input.gradle; fail(input, 'generated-inputs'); });
test('generated application ID or namespace mismatch fails', () => { const input = fixture(); input.gradle = input.gradle.replace("applicationId 'dev.yumidang.validation'", "applicationId 'com.example.other'"); fail(input, 'generated-identity'); });
test('generated version mismatch and invalid source versionCode fail', () => {
  const input = fixture(); input.gradle = input.gradle.replace('versionCode 1', 'versionCode 2'); fail(input, 'generated-version');
  input.config.android.versionCode = 0; fail(input, 'version-code');
});
test('generated camera and microphone permissions fail independently', () => {
  for (const permission of ['CAMERA', 'RECORD_AUDIO']) {
    const input = fixture(); input.manifest = input.manifest.replace('<application ', `<uses-permission android:name="android.permission.${permission}"/><application `);
    fail(input, 'generated-sensitive-permissions');
  }
});
test('image picker must explicitly disable both camera and microphone', () => {
  for (const key of ['cameraPermission', 'microphonePermission']) {
    const input = fixture(); input.config.plugins.find(p => Array.isArray(p) && p[0] === 'expo-image-picker')[1][key] = true;
    fail(input, 'picker-permission-options');
  }
});
test('cleartext enablement and missing callback fail', () => {
  const input = fixture(); input.manifest = input.manifest.replace('usesCleartextTraffic="false"', 'usesCleartextTraffic="true"'); fail(input, 'generated-cleartext');
  input.manifest = fixture().manifest.replace(VALIDATION_SCHEME, 'another-scheme'); fail(input, 'generated-schemes');
});
test('validation refuses a leaked production callback despite valid validation callback', () => {
  const input = fixture(); input.manifest = input.manifest.replace('</intent-filter>', '<data android:scheme="yumidang"/></intent-filter>'); fail(input, 'no-production-callback');
});
test('production is never approved by static settings or fixture success', () => {
  const input = fixture(); input.mode = 'production';
  const result = reviewAndroidSettings(input);
  assert.equal(result.status, 'NOT_APPROVED');
  assert.equal(result.boundaries.productionApproval, 'NOT_APPROVED');
  assert.throws(() => reviewAndroidSettings({ mode: 'release', config: source }), /mode must/);
});


test('callback requires a complete filter on an enabled exported receiver', () => {
  for (const mutate of [
    xml => xml.replace('android:exported="true"', 'android:exported="false"'),
    xml => xml.replace('android:exported="true"', ''),
    xml => xml.replace('<activity ', '<activity android:enabled="false" '),
    xml => xml.replace('<application ', '<application android:enabled="false" '),
    xml => xml.replace('<category android:name="android.intent.category.DEFAULT"/>', ''),
    xml => xml.replace('<category android:name="android.intent.category.BROWSABLE"/>', ''),
    xml => xml.replace('<action android:name="android.intent.action.VIEW"/>', ''),
    xml => xml.replace('<data ', '</intent-filter><intent-filter><data '),
    xml => xml.replace('<activity ', '<queries ').replace('</activity>', '</queries>'),
    xml => xml.replace('<activity ', '<!-- <activity ').replace('</activity>', '</activity> -->'),
    xml => xml.replace('</activity>', '</service>'),
  ]) { const input = fixture(); input.manifest = mutate(input.manifest); fail(input, 'generated-schemes'); }
});
test('exported alias requires a real enabled preceding target activity', () => {
  const input = fixture();
  input.manifest = input.manifest.replace('<activity android:name=".MainActivity" android:exported="true">', '<activity android:name=".Target" android:exported="false"/><activity-alias android:name=".MainActivity" android:targetActivity=".Target" android:exported="true">').replace('</activity>', '</activity-alias>');
  assert.equal(reviewAndroidSettings(input).status, 'PASS');
  for (const mutate of [
    xml => xml.replace('android:targetActivity=".Target"', 'android:targetActivity=".Missing"'),
    xml => xml.replace('<activity android:name=".Target"', '<activity android:enabled="false" android:name=".Target"'),
    xml => xml.replace('<activity android:name=".Target" android:exported="false"/>', '').replace('</application>', '<activity android:name=".Target"/></application>'),
  ]) fail({ ...input, manifest: mutate(input.manifest) }, 'generated-schemes');
});

test('queries-only scheme and filters in another component cannot supply callback evidence', () => {
  const input = fixture();
  input.manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><queries><intent><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="${VALIDATION_SCHEME}"/></intent></queries><application/></manifest>`;
  fail(input, 'generated-schemes');
  const second = fixture();
  second.manifest = second.manifest.replace('<data ', '</intent-filter></activity><activity android:name=".Other" android:exported="true"><intent-filter><data ');
  fail(second, 'generated-schemes');
});
