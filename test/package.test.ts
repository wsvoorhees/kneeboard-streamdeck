import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PLUGIN_NAME, PLUGIN_UUID, PLUGIN_VERSION } from '../src/identity.ts';

const bundle = path.resolve('com.willvoorhees.openkneeboard-configurator.sdPlugin');
const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));

function imagePath(reference: string, suffix = ''): string {
  const svg = path.join(bundle, `${reference}${suffix}.svg`);
  const png = path.join(bundle, `${reference}${suffix}.png`);
  if (fs.existsSync(svg)) return svg;
  if (fs.existsSync(png)) return png;
  throw new Error(`Missing image ${reference}${suffix}`);
}

test('manifest artwork is complete, local, and has high-resolution variants', () => {
  const references = [manifest.CategoryIcon, manifest.Icon, ...manifest.Actions.flatMap(
    (action: { Icon: string; States: { Image: string }[] }) =>
      [action.Icon, ...action.States.map((state) => state.Image)],
  )];
  for (const reference of references) {
    assert.match(reference, /^imgs\//);
    for (const suffix of ['', '@2x']) {
      const file = imagePath(reference, suffix);
      const contents = fs.readFileSync(file);
      if (file.endsWith('.svg')) assert.match(contents.toString('utf8'), /^<svg[^>]+viewBox=/);
      else assert.equal(contents.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
  }
});

test('plugin and action IDs use the configurator namespace', () => {
  assert.equal(manifest.Name, 'OpenKneeboard Configurator');
  assert.equal(manifest.Category, manifest.Name);
  assert.equal(manifest.UUID, 'com.willvoorhees.openkneeboard-configurator');
  assert.equal(new Set(manifest.Actions.map((action: { UUID: string }) => action.UUID)).size, manifest.Actions.length);
  for (const action of manifest.Actions) assert.ok(action.UUID.startsWith(`${manifest.UUID}.`));
});

test('every action has the bundled offline settings UI', () => {
  const file = path.join(bundle, manifest.PropertyInspectorPath);
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /connectElgatoStreamDeckSocket/);
  assert.match(html, /setSettings/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('the plugin identity matches the manifest and package version', () => {
  assert.equal(manifest.UUID, PLUGIN_UUID);
  assert.equal(manifest.Name, PLUGIN_NAME);
  assert.equal(manifest.Version, PLUGIN_VERSION);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(`${pkg.version}.0`, PLUGIN_VERSION);
});

test('every control is available on keys and dials', () => {
  const expected = [
    'profile-select', 'tab-select', 'placement-dial',
    'placement-reset', 'recentre', 'view-select', 'view-visibility', 'view-opacity',
  ];
  const ids = manifest.Actions.map((action: { UUID: string }) => action.UUID.slice(manifest.UUID.length + 1));
  assert.deepEqual(ids.sort(), expected.sort());
  const ui = fs.readFileSync(path.join(bundle, manifest.PropertyInspectorPath), 'utf8');
  for (const action of manifest.Actions) {
    assert.deepEqual([...action.Controllers].sort(), ['Encoder', 'Keypad']);
    if (!action.UUID.endsWith(".placement-dial"))
      assert.ok(action.Encoder?.TriggerDescription?.Push, `${action.Name} dial press`);
    const suffix = action.UUID.slice(manifest.UUID.length + 1);
    assert.ok(ui.includes(`'${suffix}':`), `${action.Name} settings`);
  }
});

test('included profile artwork matches the recorded source images', () => {
  const sourceDir = path.resolve('artwork-source');
  const recorded = JSON.parse(fs.readFileSync(path.join(sourceDir, 'profile-icons.json'), 'utf8')) as
    Record<string, { source: 'original' | 'material'; glyph: string; sha256: string }>;
  const profileDir = path.join(bundle, 'imgs/profile');
  assert.equal(Object.keys(recorded).length, 14);
  assert.deepEqual(fs.readdirSync(profileDir).sort(), Object.keys(recorded).sort());
  for (const [name, source] of Object.entries(recorded)) {
    const image = fs.readFileSync(path.join(profileDir, name));
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(image.readUInt32BE(16), 144);
    assert.equal(image.readUInt32BE(20), 144);
    assert.equal(createHash('sha256').update(image).digest('hex'), source.sha256);
    const svg = source.source === 'original'
      ? path.join(sourceDir, `${source.glyph}.svg`)
      : path.join(sourceDir, source.source, `${source.glyph}.svg`);
    assert.ok(fs.existsSync(svg), `${name} source SVG`);
  }
  assert.ok(fs.existsSync(path.join(bundle, 'licenses/material-symbols-apache-2.0.txt')));
});
