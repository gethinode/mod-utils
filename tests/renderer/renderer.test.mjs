// Renders mod-utils' partials in Bookshop's live-editing renderer (Hugo 0.147.6, see harness.mjs).
// Run with: node --test tests/renderer/renderer.test.mjs
//
// The exampleSite test pages are built in the renderer and compared against the same golden files
// that tests/golden.mjs compares the current Hugo's output against. A partial that guards a newer
// Hugo API takes its old branch here and its new branch in the golden build, so a passing pair
// shows both branches produce the same result.
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {bookshopConfig, createRenderer, readTree, resourceStub} from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = path.join(root, 'exampleSite');
const normalize = (s) => s.replaceAll('\r\n', '\n');

// exampleSite's hugo.toml without its module imports (the renderer resolves no modules: Bookshop
// supplies module files as extraFiles instead), after the settings Bookshop itself writes.
const siteConfig = readFileSync(path.join(site, 'hugo.toml'), 'utf8').replace(/^\[module\][\s\S]*$/m, '');
const config = `${bookshopConfig}\n${siteConfig}`;

// The image fixtures GetImage resolves, served through resourceStub (the renderer takes no binaries).
const imageDir = path.join(site, 'assets', 'img', 'orientation');
const images = Object.fromEntries(readdirSync(imageDir)
	.filter((file) => !file.endsWith('.py'))
	.map((file) => [`img/orientation/${file}`, path.join(imageDir, file)]));

// exampleSite test groups the renderer cannot build, with the reason. Their pages are left out.
const skipped = {
	'getimage-webp': 'the renderer is not Hugo extended, so it cannot encode the rotated WebP image',
};
const content = Object.fromEntries(Object.entries(readTree(path.join(site, 'content'), 'content'))
	.filter(([file]) => !Object.keys(skipped).some((group) => file === `content/tests/${group}.md`)));

let renderer;
before(async () => {
	renderer = await createRenderer({
		config,
		files: {
			// Module files first, so the site's own files take precedence, as with Hugo's module mounts.
			...readTree(path.join(root, 'layouts'), 'layouts'),
			...readTree(path.join(root, 'data'), 'data'),
			...readTree(path.join(site, 'layouts'), 'layouts'),
			...readTree(path.join(site, 'data'), 'data'),
			...content,
			...resourceStub(images),
			// Data for the controls below.
			'data/renderer_test.json': '{"greeting": "hello"}',
		},
	});
});
after(() => renderer?.close());

describe('renderer', () => {
	test('is the Hugo that Bookshop live editing runs', () => {
		const {error, output} = renderer.render('{{ hugo.Version }}');
		assert.equal(error, null);
		assert.equal(output, '0.147.6');
	});

	test('an empty render returns empty output, not the previous render', () => {
		assert.equal(renderer.render('previous').output, 'previous');
		assert.equal(renderer.render('{{ "" }}').output, '');
	});

	test('negative control: an unguarded hugo.Data fails', () => {
		const {error} = renderer.render('{{ hugo.Data.renderer_test.greeting }}');
		assert.match(error ?? 'no error', /can't evaluate field Data/);
	});

	test('negative control: cond is no guard, since it evaluates both branches', () => {
		const {error} = renderer.render('{{ cond (le (hugo.Version.Compare "0.156.0") 0) hugo.Data site.Data }}');
		assert.match(error ?? 'no error', /can't evaluate field Data/);
	});

	test('a hugo.Version guard runs the old branch', () => {
		const {error, output} = renderer.render(
			'{{ if le (hugo.Version.Compare "0.156.0") 0 }}new: {{ hugo.Data.renderer_test.greeting }}'
			+ '{{ else }}old: {{ site.Data.renderer_test.greeting }}{{ end }}',
		);
		assert.equal(error, null);
		assert.equal(output, 'old: hello');
	});
});

describe('partials in the renderer', () => {
	test('GetData returns site.Data', () => {
		const {error, output} = renderer.render('{{ (partial "utilities/GetData.html" .).renderer_test.greeting }}');
		assert.equal(error, null);
		assert.equal(output, 'hello');
	});
});

describe('exampleSite test pages in the renderer', () => {
	let built;
	before(() => {
		built = renderer.build();
	});

	test('build succeeds', () => {
		assert.equal(built.error, null, built.logs.join('\n'));
	});

	const groups = readdirSync(path.join(root, 'tests', 'golden')).map((file) => path.basename(file, '.json'));
	for (const group of groups) {
		test(`${group} matches its golden file`, {skip: skipped[group]}, () => {
			const output = `public/tests/${group}/index.json`;
			const golden = readFileSync(path.join(root, 'tests', 'golden', `${group}.json`), 'utf8');
			assert.equal(normalize(renderer.read([output])[output] ?? ''), normalize(golden));
		});
	}
});
