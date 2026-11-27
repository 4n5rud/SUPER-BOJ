import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = '.output/chrome-mv3';
const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, '116');
assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
assert.deepEqual(manifest.permissions.sort(), ['clipboardWrite', 'nativeMessaging', 'sidePanel', 'storage']);
const origins = ['https://acmicpc.net/*', 'https://www.acmicpc.net/*'];
assert.deepEqual(manifest.host_permissions.sort(), origins);
assert.deepEqual(
  manifest.optional_host_permissions?.toSorted(),
  ['https://api.github.com/*', 'https://github.com/*'],
  'Chrome 빌드의 optional_host_permissions는 GitHub HTTPS 호스트 두 개여야 합니다.',
);
assert.equal(manifest.content_scripts.length, 1);
assert.deepEqual(manifest.content_scripts[0].matches.sort(), origins);
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, ...manifest.content_scripts[0].js]) {
  await access(join(output, file));
}

for (const size of [16, 32, 48, 128]) {
  const icon = manifest.icons[size];
  assert.equal(manifest.action.default_icon[size], icon);
  const png = await readFile(join(output, icon));
  assert.equal(png.subarray(12, 16).toString(), 'IHDR');
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}
