#!/usr/bin/env node
/**
 * Runs the test suite with coverage and enforces minimum thresholds.
 *
 * Node's own `--test-coverage-lines/-branches/-functions` CLI flags are
 * supposed to do this, and do in small repros, but were found to silently
 * not fail this project's actual (~25 file, ~200 test) suite even when the
 * printed totals were below the given threshold — likely related to this
 * suite's use of cache-busted dynamic imports for per-test module isolation
 * (see README's Testing section). Rather than rely on an enforcement
 * mechanism that doesn't reliably trigger, this script parses the same
 * coverage report Node prints and checks the totals itself.
 */
import { spawn } from 'node:child_process';

const THRESHOLDS = { lines: 95, branch: 80, functions: 88 };

const args = [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-exclude=tests/**',
  '--test-coverage-exclude=node_modules/**',
  '--test-coverage-exclude=scripts/**',
  'tests/*.test.js',
];

const child = spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'inherit'] });

let output = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  output += chunk;
});

child.on('close', (testRunnerExitCode) => {
  const match = output.match(/#\s*all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
  if (!match) {
    console.error('\ncheck-coverage: could not find the "all files" summary row in the coverage report.');
    process.exit(1);
  }

  const actual = { lines: Number(match[1]), branch: Number(match[2]), functions: Number(match[3]) };
  const failures = Object.entries(THRESHOLDS).filter(([key, min]) => actual[key] < min);

  console.log('\ncheck-coverage: totals vs. required minimums');
  for (const [key, min] of Object.entries(THRESHOLDS)) {
    const ok = actual[key] >= min ? '✓' : '✗';
    console.log(`  ${ok} ${key.padEnd(10)} ${actual[key].toFixed(2)}%  (minimum ${min}%)`);
  }

  if (testRunnerExitCode !== 0) {
    console.error('\ncheck-coverage: the test suite itself failed (see above).');
    process.exit(testRunnerExitCode);
  }
  if (failures.length > 0) {
    console.error(`\ncheck-coverage: below the required minimum for: ${failures.map(([k]) => k).join(', ')}.`);
    process.exit(1);
  }
  console.log('\ncheck-coverage: all thresholds met.');
});
