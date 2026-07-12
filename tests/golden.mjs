#!/usr/bin/env node
// Compares generated test output (exampleSite/public/tests/<group>/index.json) against the
// committed golden files (tests/golden/<group>.json). Run with --update to (re)write goldens.
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const generatedRoot = path.join('exampleSite', 'public', 'tests');
const goldenRoot = path.join('tests', 'golden');
const update = process.argv.includes('--update');

const groups = readdirSync(generatedRoot, {withFileTypes: true})
	.filter((entry) => entry.isDirectory()
		&& existsSync(path.join(generatedRoot, entry.name, 'index.json')))
	.map((entry) => entry.name);

if (groups.length === 0) {
	console.error(`no generated test output found under ${generatedRoot}`);
	process.exit(1);
}

let failed = false;
const seen = new Set();
for (const group of groups) {
	const generated = readFileSync(path.join(generatedRoot, group, 'index.json'), 'utf8');
	const goldenFile = path.join(goldenRoot, `${group}.json`);
	seen.add(`${group}.json`);
	if (update) {
		mkdirSync(goldenRoot, {recursive: true});
		writeFileSync(goldenFile, generated);
		console.log(`updated ${goldenFile}`);
		continue;
	}

	if (!existsSync(goldenFile)) {
		console.error(`MISSING golden: ${goldenFile} (run: pnpm test:update)`);
		failed = true;
		continue;
	}

	const golden = readFileSync(goldenFile, 'utf8');
	if (golden !== generated) {
		failed = true;
		console.error(`DIFF in group '${group}' (golden vs generated):`);
		const a = golden.split('\n');
		const b = generated.split('\n');
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			if (a[i] !== b[i]) {
				console.error(`  line ${i + 1}:\n  - ${a[i] ?? '<missing>'}\n  + ${b[i] ?? '<missing>'}`);
			}
		}
	}
}

if (!update && existsSync(goldenRoot)) {
	for (const file of readdirSync(goldenRoot)) {
		if (!seen.has(file)) {
			console.error(`ORPHAN golden without generated output: ${file}`);
			failed = true;
		}
	}
}

if (failed) process.exit(1);
console.log(`golden check passed (${groups.length} groups)`);
