#!/usr/bin/env node
// Type-checks the backend with TypeScript's checkJs, without changing how the
// site is deployed.
//
// Velo requires web modules to keep the .jsw extension, and tsc silently ignores
// files it does not recognise — a tsconfig that "includes" src/**/*.jsw type-checks
// nothing and reports success. So this mirrors src/ into .typecheck/ with .jsw
// renamed to .js, runs tsc there, and maps the paths in any diagnostics back to
// the real files.
//
// Checking is opt-in per file: only files carrying a `// @ts-check` comment are
// checked, so new annotations can be added a file at a time without a repo-wide
// cleanup. See tsconfig.json (checkJs is deliberately false).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, '.typecheck');
const MIRROR = path.join(OUT, 'src');

function mirror(dir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      mirror(from, path.join(outDir, entry.name));
      continue;
    }
    if (!/\.(js|jsw)$/.test(entry.name)) continue;

    // Drop the .jsw extension from import specifiers too, so the rewritten files
    // resolve to each other through the tsconfig path mapping.
    const source = fs.readFileSync(from, 'utf8').replace(/(\bfrom\s+['"][^'"]+)\.jsw(['"])/g, '$1$2');
    fs.writeFileSync(path.join(outDir, entry.name.replace(/\.jsw$/, '.js')), source);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
mirror(SRC, MIRROR);
fs.cpSync(path.join(ROOT, 'types'), path.join(OUT, 'types'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tsconfig.json'), path.join(OUT, 'tsconfig.json'));

const tsc = path.join(ROOT, 'node_modules', '.bin', 'tsc');
try {
  execFileSync(tsc, ['-p', path.join(OUT, 'tsconfig.json')], { stdio: 'pipe', encoding: 'utf8' });
  console.log('[typecheck] No type errors in @ts-check files.');
} catch (err) {
  const output = String(err.stdout || '') + String(err.stderr || '');
  // Point diagnostics at the real files rather than the mirror.
  const mapped = output
    .split('\n')
    .map((line) => line.replace(/(^|\s)src\//, '$1src/'))
    .join('\n');
  process.stdout.write(mapped);
  console.error('[typecheck] Type errors found.');
  process.exit(1);
}
