import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Only delete the build output adjacent to this checkout, never a caller-supplied path.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], { stdio: 'inherit', cwd: fileURLToPath(new URL('../', import.meta.url)) });
process.exit(result.status ?? 1);
