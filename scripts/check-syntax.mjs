import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function checkDirectory(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(file);
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) {
        console.error(`${file}: ${result.stderr || result.stdout || result.error?.message}`);
        process.exitCode = 1;
      }
    }
  }
}

await checkDirectory(path.resolve('src'));
