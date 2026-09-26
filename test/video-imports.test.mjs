import assert from 'node:assert/strict';
import test from 'node:test';

test('video canonical exports keep old bindings', async () => {
  for (const [oldName, nextName, symbol] of [
    ['task-point','media','waitForMediaTaskCompletion'],
    ['task-point','media','startMediaPlayback'],
    ['video-runner','runner','playManifestVideo'],
    ['video-preview','preview','startVideoPreview'],
  ]) {
    const legacy = await import(`../src/${oldName}.mjs`);
    const canonical = await import(`../src/video/${nextName}.mjs`);
    assert.strictEqual(legacy[symbol], canonical[symbol]);
  }
});
