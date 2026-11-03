#!/usr/bin/env node
// Builds exampleSite and fails when Hugo logs one of the deprecations below. Hugo logs a
// deprecation when the deprecated call executes, so this proves that a guarded partial takes its
// new branch on the installed Hugo. --logLevel info also shows deprecations Hugo logs at INFO.
import {spawnSync} from 'node:child_process';
import process from 'node:process';

const forbidden = [
	/deprecated: \.Site\.Data\b/,
];

// Run through the shell, as the package.json script it replaces ran hugo. One command string,
// not an argument list: Node deprecates passing arguments with shell: true (DEP0190).
const result = spawnSync('hugo -s exampleSite --logLevel info', {encoding: 'utf8', shell: true});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const log = `${result.stdout}\n${result.stderr}`;
const found = forbidden.filter((pattern) => pattern.test(log));
for (const pattern of found) console.error(`FORBIDDEN deprecation logged: ${pattern}`);
if (found.length > 0) process.exit(1);
console.log(`deprecation check passed (${forbidden.length} patterns)`);
