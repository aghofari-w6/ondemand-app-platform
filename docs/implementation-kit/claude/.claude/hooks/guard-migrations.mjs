#!/usr/bin/env node
// PreToolUse hook: migrations are immutable once merged. Blocks Edit/Write on a
// migration file that exists on the main branch; new migration files (and ones only
// on the current milestone branch) are allowed.
// Exit code 2 blocks the tool call and shows stderr to Claude.
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let file;
try {
  file = JSON.parse(input)?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (!file) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rel = relative(root, file).split('\\').join('/');
const isMigration = /^(db\/migrations|templates\/[^/]+\/migrations)\/[^/]+\.sql$/.test(rel);
if (!isMigration) process.exit(0);

const onMain = ['origin/main', 'main'].some((ref) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${rel}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!onMain) process.exit(0);

console.error(
  `${rel} is merged to main and must not change. Add a new migration file instead ` +
    '(for a template release, list it in the manifest release and keep it expand-only).',
);
process.exit(2);
