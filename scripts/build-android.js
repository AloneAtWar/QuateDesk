import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const wrapper = isWindows ? 'gradlew.bat' : './gradlew';
const result = spawnSync(wrapper, ['assembleDebug'], {
  cwd: path.join(repoRoot, 'android'),
  stdio: 'inherit',
  shell: isWindows,
});

process.exit(result.status ?? 1);
