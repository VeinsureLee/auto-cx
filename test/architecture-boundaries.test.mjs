import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const sourceRoot = path.resolve('src');

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : (entry.isFile() && file.endsWith('.mjs') ? [file] : []);
  }));
  return children.flat();
}

test('syntax checker reaches nested modules', async () => {
  const fixture = path.join(sourceRoot, '__syntax-fixture__');
  try {
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'broken.mjs'), 'export const = ;\n');
    const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run check'] : ['run', 'check'];
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /broken\.mjs/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('canonical modules never depend on compatibility shims or form import cycles', async () => {
  const domains = new Set(['platform', 'assessment', 'video', 'learning', 'persistence', 'shared']);
  const shims = new Set(['answerer','courses','course-navigation','course-progress','quiz','study','study-memo','study-progress','study-scheduler','study-selectors','task-manifest','task-point','task-point-status','video-preview','video-runner']);
  const graph = new Map();
  for (const file of await sourceFiles(sourceRoot)) {
    const domain = path.relative(sourceRoot, file).split(path.sep)[0];
    if (!domains.has(domain)) continue;
    const source = await readFile(file, 'utf8');
    const references = [...source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+\.mjs)['"]/g)];
    const neighbors = [];
    for (const [, specifier] of references) {
      const target = path.resolve(path.dirname(file), specifier);
      if (path.dirname(target) === sourceRoot) {
        assert.ok(!shims.has(path.basename(target, '.mjs')), `${file} imports root shim ${specifier}`);
      } else if (target.startsWith(sourceRoot + path.sep)) {
        neighbors.push(target);
      }
    }
    graph.set(file, neighbors);
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(file) {
    assert.ok(!visiting.has(file), `circular import at ${file}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const neighbor of graph.get(file) ?? []) visit(neighbor);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
});
