#!/usr/bin/env node
// Builds exampleSite once per config overlay in tests/matrix (<name>.toml) and compares the
// getpage group's output, from every site that renders it, against tests/matrix/<name>.json.
// Run with --update to (re)write those files.
//
// GetPage's fallback match must cover the pages site.AllPages returns: those of every language,
// in the first version and the first role of Hugo's sort order. The overlays add versions or
// roles whose default is not the first, and render the test page on each, so a match against
// every site's pages, the default site's or the current site's gives a different result.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const matrixRoot = path.join('tests', 'matrix');
const output = path.join('tests', 'getpage', 'index.json');
const update = process.argv.includes('--update');

const overlays = readdirSync(matrixRoot)
	.filter((file) => file.endsWith('.toml'))
	.map((file) => path.basename(file, '.toml'));
if (overlays.length === 0) {
	console.error(`no config overlays found under ${matrixRoot}`);
	process.exit(1);
}

let failed = false;
for (const name of overlays) {
	const destination = mkdtempSync(path.join(os.tmpdir(), `mod-utils-matrix-${name}-`));
	try {
		// One command string through the shell, as tests/deprecations.mjs runs hugo.
		const overlay = path.resolve(matrixRoot, `${name}.toml`);
		const command = `hugo -s exampleSite --config "hugo.toml,${overlay}" -d "${destination}"`;
		const result = spawnSync(command, {encoding: 'utf8', shell: true});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			process.stdout.write(result.stdout ?? '');
			process.stderr.write(result.stderr ?? '');
			console.error(`BUILD FAILED with overlay '${name}'`);
			failed = true;
			continue;
		}

		// {'<URL path of the test page>': <its output>}, e.g. '/v1/tests/getpage/'.
		const sites = {};
		const files = readdirSync(destination, {recursive: true})
			.filter((file) => file === output || file.endsWith(`${path.sep}${output}`))
			.sort();
		for (const file of files) {
			const url = `/${path.dirname(file).split(path.sep).join('/')}/`;
			sites[url] = JSON.parse(readFileSync(path.join(destination, file), 'utf8'));
		}

		const generated = `${JSON.stringify(sites, null, 2)}\n`;
		const goldenFile = path.join(matrixRoot, `${name}.json`);
		if (update) {
			writeFileSync(goldenFile, generated);
			console.log(`updated ${goldenFile}`);
			continue;
		}

		if (!existsSync(goldenFile)) {
			console.error(`MISSING golden: ${goldenFile} (run: node tests/matrix.mjs --update)`);
			failed = true;
			continue;
		}

		const golden = readFileSync(goldenFile, 'utf8').replaceAll('\r\n', '\n');
		if (golden !== generated) {
			failed = true;
			console.error(`DIFF with overlay '${name}' (golden vs generated):`);
			const a = golden.split('\n');
			const b = generated.split('\n');
			for (let i = 0; i < Math.max(a.length, b.length); i++) {
				if (a[i] !== b[i]) {
					console.error(`  line ${i + 1}:\n  - ${a[i] ?? '<missing>'}\n  + ${b[i] ?? '<missing>'}`);
				}
			}
		}
	} finally {
		rmSync(destination, {recursive: true, force: true});
	}
}

if (failed) process.exit(1);
console.log(`matrix check passed (${overlays.length} overlays)`);
