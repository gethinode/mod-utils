# Argument and Type System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the internals of mod-utils' argument validation (`InitArgs.html`/`InitTypes.html`) with a cached schema compiler plus a recursive validator behind a clean `Args.html` API, pinned by a golden-file test harness — while every existing call site keeps working through compatibility shims.

**Architecture:** Two new partials separate concerns: `ArgsSchema.html` compiles the YAML contract (global `_arguments.yml`, `_types.yml`, structure files, Bookshop blueprints + sidecars, child structures) into a self-contained recursive schema tree, invoked via `partialCached`; `Args.html` walks values against that tree with a recursive inline validator and returns a separated envelope `{args, err, errmsg, warnmsg, defaulted}`. `InitArgs.html` and `InitTypes.html` become thin shims. A golden-file harness in the exampleSite characterizes current behavior *first*; every intentional behavior change lands as a reviewable golden diff.

**Tech Stack:** Hugo templates (min 0.146, CI pins hugo-extended 0.164 via pnpm), YAML data files, one dependency-free Node script for golden comparison.

**Spec:** `docs/superpowers/specs/2026-07-12-args-type-system-redesign-design.md` (read it before starting; §1.1 numbers the defects referenced as BUG(n) below).

## Global Constraints

- Repository: `/Users/mark/Development/GitHub/gethinode/mod-utils`. Work on a feature branch off `main` (e.g. `feat/args-system-redesign`); never commit to `main`.
- No changes to the YAML schema of `_arguments.yml`, `_types.yml`, structure files, blueprints, or sidecars (spec §2.1). Test fixtures ADD files; they never modify shipped data except where a task says so.
- No new npm dependencies. The golden script is plain Node (`.mjs`, no imports beyond `node:` builtins).
- All new partials live in `layouts/_partials/utilities/` — CloudCannon expose-glob placement rule (spec §1.3.2). No new data directories in the module itself.
- Hugo min version 0.146 (see `config.toml`); use no template functions newer than that.
- Commit messages: Angular Conventional Commits, body lines ≤ 100 chars, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The pre-commit hook runs `pnpm build` (full exampleSite build). Commits fail if the site doesn't build.
- Run all commands from the repo root. `pnpm exec hugo` is the pinned Hugo binary.
- **Golden discipline:** when a golden file changes, the step MUST say why. An unexplained golden diff is a bug in your change — stop and investigate, never blindly update.
- Null semantics (spec §1.3.3): `null`/absent = "not provided" (eligible for defaults, exempt from type errors) at every nesting level. Explicit `false`/`0`/`""` are provided values and get validated. Never conflate these.

---

### Task 1: Golden-file harness skeleton

**Files:**
- Modify: `exampleSite/hugo.toml` (add data mount — verified necessary: the explicit `module.imports.mounts` drop the module's own `data` mount, so `site.Data.structures` is currently empty in exampleSite builds)
- Create: `exampleSite/layouts/tests/single.json` (test runner layout; old-style template naming verified to resolve on Hugo 0.164)
- Create: `exampleSite/content/tests/envelope.md`
- Create: `exampleSite/data/tests/envelope.yml`
- Create: `exampleSite/data/structures/test-envelope.yml`
- Create: `tests/golden.mjs`
- Modify: `package.json` (scripts)
- Test: the harness itself — `pnpm test` fails on drift, passes on match

**Interfaces:**
- Produces: `pnpm test` (build exampleSite + compare `exampleSite/public/tests/<group>/index.json` against `tests/golden/<group>.json`), `pnpm test:update` (regenerate goldens). Case-file format consumed by all later tasks:

```yaml
# exampleSite/data/tests/<group>.yml
cases:
  - name: unique-case-name       # key in the JSON output
    structure: test-something    # OR bookshop: test-hero
    child: test-card             # optional
    group: shortcode             # optional
    named: true                  # optional, default true; false = args is a positional slice
    args: {}                     # map (named) or list (positional)
```

- [ ] **Step 1: Add the data mount to `exampleSite/hugo.toml`**

Append to the existing `[[module.imports.mounts]]` list (inside the same `[[module.imports]]` block):

```toml
  [[module.imports.mounts]]
    source = "data"
    target = "data"
```

- [ ] **Step 2: Write the test-runner layout**

Create `exampleSite/layouts/tests/single.json`:

```go-html-template
{{- /*
    Test runner: renders the InitArgs result envelope for every case in the group's case file
    (data/tests/<group>.yml) or, when the page defines cases in frontmatter, from .Params.cases.
    Output is canonical JSON (jsonify sorts map keys) compared against tests/golden/<group>.json.
*/ -}}
{{- $group := .File.ContentBaseName -}}
{{- $data := index site.Data.tests $group | default .Params -}}
{{- $results := dict -}}
{{- range $case := $data.cases -}}
    {{- $params := dict
        "structure" ($case.structure | default "")
        "args"      $case.args
        "named"     (ne $case.named false)
    -}}
    {{- with $case.bookshop }}{{ $params = merge $params (dict "bookshop" . "structure" "") }}{{ end -}}
    {{- with $case.child }}{{ $params = merge $params (dict "child" .) }}{{ end -}}
    {{- with $case.group }}{{ $params = merge $params (dict "group" .) }}{{ end -}}
    {{- $legacy := partial "utilities/InitArgs.html" $params -}}
    {{- $results = merge $results (dict $case.name (dict "initargs" $legacy)) -}}
{{- end -}}
{{- jsonify (dict "indent" "  ") $results -}}
```

- [ ] **Step 3: Write the first fixture and case group (envelope characterization, BUG(5))**

Create `exampleSite/data/structures/test-envelope.yml`:

```yaml
comment: >-
  Test fixture demonstrating the envelope namespace collision: an argument named
  'default' shares the return map with the bookkeeping 'default' slice.
arguments:
  default:
    type: string
    optional: true
  plain:
    type: string
    optional: true
```

Create `exampleSite/data/tests/envelope.yml`:

```yaml
cases:
  - name: plain-arg
    structure: test-envelope
    args:
      plain: hello
  # BUG(5): the user's value for 'default' is clobbered by the bookkeeping merge
  - name: default-arg-collision
    structure: test-envelope
    args:
      default: user-value
```

Create `exampleSite/content/tests/envelope.md`:

```markdown
---
title: Envelope
outputs: ["json"]
---
```

- [ ] **Step 4: Write the golden comparison script**

Create `tests/golden.mjs`:

```js
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
```

- [ ] **Step 5: Add npm scripts**

In `package.json`, replace `"test": "pnpm build"` with:

```json
"pretest": "pnpm clean && pnpm mod:vendor",
"test": "hugo -s exampleSite && node tests/golden.mjs",
"test:update": "pnpm clean && pnpm mod:vendor && hugo -s exampleSite && node tests/golden.mjs --update"
```

Note: `test` deliberately builds WITHOUT `--minify` so the JSON output keeps its `jsonify` indentation for reviewable golden diffs.

- [ ] **Step 6: Run, verify failure mode, generate goldens, verify pass**

```bash
pnpm test          # Expected: exit 1, "MISSING golden: tests/golden/envelope.json"
pnpm test:update   # Expected: "updated tests/golden/envelope.json"
pnpm test          # Expected: "golden check passed (1 groups)"
```

- [ ] **Step 7: Inspect the golden and confirm BUG(5) is characterized**

Open `tests/golden/envelope.json`. Expected shape: `default-arg-collision.initargs.default` is `[]` (the bookkeeping slice), NOT `"user-value"` — the user's value was clobbered. Add nothing; the golden IS the characterization. If instead you see `"user-value"`, the collision behaves differently than the spec assumed — record what you see; the golden pins reality.

- [ ] **Step 8: Commit**

```bash
git add exampleSite package.json tests
git commit -m "test: add golden-file harness with envelope characterization"
```

---

### Task 2: Characterization — defaults, casting, and options groups

**Files:**
- Create: `exampleSite/data/structures/test-default.yml`, `test-cast.yml`, `test-options.yml`
- Create: `exampleSite/data/tests/defaults.yml`, `casting.yml`, `options.yml`
- Create: `exampleSite/content/tests/defaults.md`, `casting.md`, `options.md`
- Modify: `exampleSite/hugo.toml` (add `[params]` for config-lookup cases)

**Interfaces:**
- Consumes: harness from Task 1.
- Produces: goldens `tests/golden/{defaults,casting,options}.json` pinning BUG(3) and BUG(4).

- [ ] **Step 1: Add site params used by config-lookup cases to `exampleSite/hugo.toml`**

```toml
[params.test]
  enabled = true
  disabled = false
  label = "from-site-params"
```

- [ ] **Step 2: Fixtures**

Create `exampleSite/data/structures/test-default.yml`:

```yaml
comment: Test fixture for static, config-based, and deprecated defaults.
arguments:
  static-label:
    type: string
    optional: true
    default: fallback
  from-config:
    type: string
    optional: true
    config: test.label
    default: static-fallback
  from-config-true:
    type: bool
    optional: true
    config: test.enabled
    default: false
  from-config-false:
    type: bool
    optional: true
    config: test.disabled
    default: true
  from-config-missing:
    type: string
    optional: true
    config: test.does-not-exist
    default: static-fallback
  legacy-arg:
    type: string
    optional: true
    deprecated: 1.2.0
    alternative: static-label
```

Create `exampleSite/data/structures/test-cast.yml`:

```yaml
comment: Test fixture for type casting, scalar validation, and generic collection types.
arguments:
  flag:
    type: bool
    optional: true
  count:
    type: int
    optional: true
  ratio-value:
    type: float
    optional: true
  label:
    type: string
    optional: true
  data:
    type: dict
    optional: true
  items-list:
    type: slice
    optional: true
```

Create `exampleSite/data/structures/test-options.yml`:

```yaml
comment: Test fixture for permitted values and numeric ranges.
arguments:
  mode:
    type: select
    optional: true
    default: auto
    options:
      values: [auto, manual]
  size:
    type: int
    optional: true
    options:
      min: 1
      max: 10
```

- [ ] **Step 3: Case files**

Create `exampleSite/data/tests/defaults.yml`:

```yaml
cases:
  - name: static-default-applied
    structure: test-default
    args: {}
  - name: static-default-overridden
    structure: test-default
    args: {static-label: custom}
  - name: config-present-wins
    structure: test-default
    args: {}
  # BUG(4): site param explicitly false falls through to the static default (or-based lookup)
  - name: config-false-fallthrough
    structure: test-default
    args: {}
  - name: deprecated-warns
    structure: test-default
    args: {legacy-arg: old}
```

(Note: `config-*` cases exercise different arguments of the same structure in one call each; keep them
as separate named cases anyway so each behavior has its own addressable golden entry — the runner
result includes all arguments per case, and the case name documents which argument is under test.)

Create `exampleSite/data/tests/casting.yml`:

```yaml
cases:
  - name: string-to-bool
    structure: test-cast
    args: {flag: "true"}
  - name: string-to-int
    structure: test-cast
    args: {count: "42"}
  - name: string-to-float
    structure: test-cast
    args: {ratio-value: "1.5"}
  - name: int-to-string
    structure: test-cast
    args: {label: 7}
  - name: bool-arg-real-bool
    structure: test-cast
    args: {flag: true}
  # BUG(3): explicit false skips type validation entirely — a bool false into an int arg passes
  - name: falsy-wrong-type-skips-validation
    structure: test-cast
    args: {count: false}
  - name: wrong-type-errors
    structure: test-cast
    args: {count: [1, 2]}
  # Latent quirk: type 'float' expects reflect name 'float', but real floats reflect as 'float64'
  - name: real-float-value
    structure: test-cast
    args: {ratio-value: 1.5}
  # Latent quirk: the legacy float regex matches the empty string
  - name: empty-string-float
    structure: test-cast
    args: {ratio-value: ""}
  - name: generic-dict-as-map
    structure: test-cast
    args:
      data: {anything: goes}
  # Legacy quirk kept on purpose: type 'dict' also accepts a slice of maps
  - name: generic-dict-as-maplist
    structure: test-cast
    args:
      data:
        - anything: goes
  - name: generic-slice
    structure: test-cast
    args:
      items-list: [1, "two", true]
```

Create `exampleSite/data/tests/options.yml`:

```yaml
cases:
  - name: select-valid
    structure: test-options
    args: {mode: manual}
  - name: select-invalid
    structure: test-options
    args: {mode: bogus}
  - name: select-default
    structure: test-options
    args: {}
  - name: range-inside
    structure: test-options
    args: {size: 5}
  - name: range-below-min
    structure: test-options
    args: {size: 0}
  - name: range-above-max
    structure: test-options
    args: {size: 11}
```

Create the three content pages (same frontmatter as Task 1 Step 3, adjusting `title`):
`exampleSite/content/tests/defaults.md`, `casting.md`, `options.md`, each:

```markdown
---
title: <Group>
outputs: ["json"]
---
```

- [ ] **Step 4: Generate, inspect, commit**

```bash
pnpm test:update && pnpm test   # Expected: "golden check passed (4 groups)"
```

Inspect each new golden. Expected characterizations to verify and note inline (as YAML comments in the case files if reality differs from the BUG annotations): `config-false-fallthrough` shows `fromConfigFalse: true` (the static default — BUG(4)); `falsy-wrong-type-skips-validation` shows `err: false` (BUG(3)); `real-float-value` — record whatever happens (this pins the float/float64 quirk, whichever way it goes). Then:

```bash
git add exampleSite tests/golden
git commit -m "test: characterize defaults, casting, and options behavior"
```

---

### Task 3: Characterization — positional, required, and group-filtered arguments

**Files:**
- Create: `exampleSite/data/structures/test-required.yml`
- Create: `exampleSite/data/tests/positional.yml`, `required.yml`
- Create: `exampleSite/content/tests/positional.md`, `required.md`

**Interfaces:** consumes Task 1 harness; produces goldens pinning BUG(6) (first-error-wins) and positional/required/group semantics.

- [ ] **Step 1: Fixture**

Create `exampleSite/data/structures/test-required.yml`:

```yaml
comment: Test fixture for required, positional, and group-scoped arguments.
arguments:
  name:
    type: string
    optional: false
    position: 0
  kind:
    type: string
    optional: true
    position: 1
  partial-only:
    type: string
    optional: false
    group: partial
  flag:
    type: bool
    optional: true
```

- [ ] **Step 2: Case files**

Create `exampleSite/data/tests/positional.yml`:

```yaml
cases:
  - name: both-positions
    structure: test-required
    named: false
    group: shortcode
    args: ["alpha", "beta"]
  - name: first-position-only
    structure: test-required
    named: false
    group: shortcode
    args: ["alpha"]
  - name: excess-position-errors
    structure: test-required
    named: false
    group: shortcode
    args: ["alpha", "beta", "gamma"]
```

Create `exampleSite/data/tests/required.yml`:

```yaml
cases:
  - name: required-provided
    structure: test-required
    group: shortcode
    args: {name: alpha}
  - name: required-missing-errors
    structure: test-required
    group: shortcode
    args: {flag: true}
  - name: group-filter-skips-partial-arg
    structure: test-required
    group: shortcode
    args: {name: alpha}
  - name: group-partial-requires-both
    structure: test-required
    group: partial
    args: {name: alpha}
  - name: no-group-requires-all
    structure: test-required
    args: {name: alpha}
  # BUG(6): two problems, only the first reported (break on first error)
  - name: first-error-wins
    structure: test-required
    group: shortcode
    args: {bogus-one: 1, bogus-two: 2}
```

Create `exampleSite/content/tests/positional.md` and `required.md` (frontmatter pattern from Task 1 Step 3).

- [ ] **Step 3: Generate, inspect, commit**

```bash
pnpm test:update && pnpm test   # Expected: "golden check passed (6 groups)"
```

Verify `first-error-wins` reports exactly one `errmsg` entry (BUG(6)), and `group-partial-requires-both` errors on the missing `partial-only`.

```bash
git add exampleSite tests/golden
git commit -m "test: characterize positional, required, and group-scoped arguments"
```

---

### Task 4: Characterization — nested types, child structures, and frontmatter-typed values

**Files:**
- Create: `exampleSite/data/structures/_types.yml` (project-level copy of the module's file plus test types — the project file SHADOWS the module's per Hugo data precedence; header comment must state the sync obligation)
- Create: `exampleSite/data/structures/test-nested.yml`, `test-stack.yml`, `test-card.yml`
- Create: `exampleSite/data/tests/nesting.yml`, `child.yml`
- Create: `exampleSite/content/tests/nesting.md`, `child.md`, `frontmatter.md`

**Interfaces:** consumes Task 1 harness; produces goldens pinning BUG(1) (nested defaults use parent's default), BUG(2) (zero-deep validation), child-structure merging, and frontmatter-vs-data value typing (`maps.Params` vs `map[string]interface {}`).

- [ ] **Step 1: Create the shadowing `_types.yml`**

Copy the module file and append test types:

```bash
cp data/structures/_types.yml exampleSite/data/structures/_types.yml
```

Prepend this header comment to the copy:

```yaml
# NOTE: this file SHADOWS the module's data/structures/_types.yml for exampleSite builds
# (project data files take precedence per file). Keep the production entries in sync when
# the module file changes, and append test-only types below the marker.
```

Append at the end:

```yaml
  # --- test-only types below this marker ---
```

(No test types are needed yet — Task 6 appends one below the marker. The marker line itself must
exist so later appends have an anchor and the sync obligation stays visible.)

- [ ] **Step 2: Fixtures**

Create `exampleSite/data/structures/test-nested.yml`:

```yaml
comment: >-
  Test fixture for nested user-defined types. 'heading' is a dict UDT with defaulted
  members; 'locations' nests a second UDT ('instructions') for depth-3 coverage.
arguments:
  heading:
    optional: true
  locations:
    optional: true
  title:
    type: string
    optional: true
```

Create `exampleSite/data/structures/test-card.yml` (child structure; `parent`-flagged args cascade into the parent schema):

```yaml
comment: Test child structure exercising the 'child' parameter of InitArgs.
arguments:
  hook:
    type: string
    optional: true
    parent: cascade
    default: child-default
  ratio:
    type: string
    optional: true
    parent: merge
  ignored-non-parent:
    type: string
    optional: true
```

Create `exampleSite/data/structures/test-stack.yml`:

```yaml
comment: Test parent structure used together with the test-card child structure.
arguments:
  title:
    type: string
    optional: true
```

- [ ] **Step 3: Case files**

Create `exampleSite/data/tests/nesting.yml`:

```yaml
cases:
  # BUG(1): heading omitted → members with defaults get keys but the PARENT's (nil) default
  # as value. Verified live: {"align": null, "arrangement": null, "size": null, "width": null}
  # even though _arguments.yml gives align default 'start' and width default 8.
  - name: absent-udt-shape-fill
    structure: test-nested
    args: {}
  - name: heading-valid
    structure: test-nested
    args:
      heading:
        title: Hello
        align: center
  # BUG(2): nested member type violations pass silently (align expects a select string)
  - name: nested-wrong-type-passes
    structure: test-nested
    args:
      heading:
        title: Hello
        align: 42
  # BUG(2): unknown nested members pass silently
  - name: nested-unknown-key-passes
    structure: test-nested
    args:
      heading:
        title: Hello
        typo-key: oops
  - name: depth-three-nesting
    structure: test-nested
    args:
      locations:
        - title: Office
          instructions:
            - title: Parking
              description: Use lot B
  - name: udt-list-empty
    structure: test-nested
    args:
      locations: []
  # spec §1.3.3: null members are "not provided" — CloudCannon writes these
  - name: nested-null-members
    structure: test-nested
    args:
      heading:
        title: Hello
        preheading: null
        align: null
```

Create `exampleSite/data/tests/child.yml`:

```yaml
cases:
  - name: child-args-cascade
    structure: test-stack
    child: test-card
    args: {title: Stack, hook: custom-hook}
  # child arg defaults are stripped when merged (InitTypes drops 'default' for parent args)
  - name: child-default-stripped
    structure: test-stack
    child: test-card
    args: {title: Stack}
  - name: child-non-parent-arg-rejected
    structure: test-stack
    child: test-card
    args: {ignored-non-parent: nope}
```

Create `exampleSite/content/tests/nesting.md` and `child.md` (frontmatter pattern from Task 1 Step 3).

- [ ] **Step 4: Frontmatter-typed group**

Create `exampleSite/content/tests/frontmatter.md` — cases live in FRONTMATTER so values arrive as
Hugo params (`maps.Params`, lowercased keys) exactly as CloudCannon/Bookshop content does, instead
of data-file typing. The runner layout already falls back to `.Params` when no data file exists.

```markdown
---
title: Frontmatter
outputs: ["json"]
cases:
  - name: params-typed-nested-map
    structure: test-nested
    args:
      heading:
        title: Hello
        align: center
  - name: params-typed-scalars
    structure: test-cast
    args:
      flag: true
      count: 42
---
```

- [ ] **Step 5: Generate, inspect carefully, commit**

```bash
pnpm test:update && pnpm test   # Expected: "golden check passed (9 groups)"
```

Critical inspection: compare `params-typed-nested-map` (frontmatter group) against `heading-valid`
(nesting group). If the frontmatter one shows a type error where the data one passes, the `%T`
string-matching has a `maps.Params` blind spot — a new latent defect. Record it as a `# BUG:` comment
on the case and list it in the commit body; the strict core (Task 7+) must handle both map types via
`reflect.IsMap`.

```bash
git add exampleSite tests/golden
git commit -m "test: characterize nested types, child structures, and frontmatter typing"
```

---

### Task 5: Characterization — Bookshop components (CloudCannon-shaped payloads)

**Files:**
- Create: `exampleSite/data/structures/components/test-hero/test-hero.bookshop.yml`
- Create: `exampleSite/data/structures/components/test-hero/test-hero.yml`
- Create: `exampleSite/data/tests/bookshop.yml`
- Create: `exampleSite/content/tests/bookshop.md`

**Interfaces:** consumes Task 1 harness; produces `tests/golden/bookshop.json` pinning blueprint derivation, sidecar merging, snake/kebab normalization, implicit args, and null-heavy CloudCannon payloads (spec §1.3.3).

- [ ] **Step 1: Component fixtures**

Create `exampleSite/data/structures/components/test-hero/test-hero.bookshop.yml`:

```yaml
spec:
  structures:
    - content_blocks
  label: Test hero
  description: Bookshop fixture for schema derivation tests
  icon: title
  tags: []
blueprint:
  heading:
    title:
    align: start
  link_type: button
  show_more: false
  width: 8
```

Create the sidecar `exampleSite/data/structures/components/test-hero/test-hero.yml`
(kebab keys on purpose — exercises the snake↔kebab sidecar merge):

```yaml
comment: Sidecar for the test hero component.
arguments:
  heading:
    optional: false
  link-type:
    type: select
    optional: true
    options:
      values: [button, link]
  show-more:
    type: bool
    optional: true
  width:
    type: int
    optional: true
```

- [ ] **Step 2: Case file**

Create `exampleSite/data/tests/bookshop.yml`:

```yaml
cases:
  - name: snake-case-args
    bookshop: test-hero
    args:
      _bookshop_name: test-hero
      heading:
        title: Hello
      link_type: link
      show_more: true
  - name: kebab-case-warns
    bookshop: test-hero
    args:
      heading:
        title: Hello
      link-type: link
  # CloudCannon-shaped: every blueprint key present, untouched fields null, implicit args set
  - name: cloudcannon-null-heavy
    bookshop: test-hero
    args:
      _bookshop_name: test-hero
      _ordinal: 0
      heading:
        title: Hello
        align: null
      link_type: null
      show_more: null
      width: null
  # explicit falsy values are NOT null — pin the distinction (spec §1.3.3)
  - name: cloudcannon-explicit-false
    bookshop: test-hero
    args:
      _bookshop_name: test-hero
      heading:
        title: Hello
      show_more: false
      width: 0
  - name: bookshop-prefix-via-structure
    structure: bookshop-test-hero
    args:
      heading:
        title: Hello
  - name: unknown-bookshop-arg
    bookshop: test-hero
    args:
      heading:
        title: Hello
      bogus: nope
```

Create `exampleSite/content/tests/bookshop.md` (frontmatter pattern from Task 1 Step 3).

- [ ] **Step 3: Generate, inspect, commit**

```bash
pnpm test:update && pnpm test   # Expected: "golden check passed (10 groups)"
```

Inspect: `cloudcannon-null-heavy` must have `err: false` (nulls tolerated today — this MUST stay
true forever); `kebab-case-warns` shows the prefer-snake_case warning; note in a case comment
whether the blueprint scalar default (`align: start`, `width: 8`) survives the sidecar merge —
current code discards a scalar blueprint default when a sidecar entry merges over it (candidate
defect; the core fixes it in Task 6 and the golden flip will show it).

```bash
git add exampleSite tests/golden
git commit -m "test: characterize bookshop blueprint, sidecar, and cloudcannon payloads"
```

Phase-0 exit gate: 10 golden groups committed, `pnpm test` green, every BUG(n) from spec §1.1 that
is observable through the public API has at least one pinned case.

---

### Task 6: `ArgsSchema.html` — cached schema compiler

**Files:**
- Create: `layouts/_partials/utilities/ArgsSchema.html`
- Create: `exampleSite/data/structures/test-cycle.yml`
- Modify: `exampleSite/data/structures/_types.yml` (append cycle type)
- Create: `exampleSite/data/tests/schema.yml`, `exampleSite/content/tests/schema.md`
- Modify: `exampleSite/layouts/tests/single.json` (support `api: schema` cases)

**Interfaces:**
- Consumes: YAML data sources (unchanged).
- Produces — the contract every later task depends on:

```text
partial "utilities/ArgsSchema.html" (dict "structure" S "bookshop" B "child" C)
  → dict:
      "schema"    map: declared argument name → node
      "positions" map: position as string → argument name
      "err"       bool
      "errmsg"    []string, each prefixed "schema:" for compile-time problems
node:
      "name"       string   declared argument name
      "camelKey"   string   canonical access key (kebab/snake → camelCase, leading _ kept)
      "types"      []string declared type names
      "accepts"    []string value-kind tokens: string|bool|int|float|map|slice|maplist
      "kind"       string   scalar|dict|list
      "children"   map      member name → node (single user-defined type only)
      "udtType"    string   the user-defined type name (only when children present)
      "default", "config", "options", "optional", "position", "group" ([]string),
      "deprecated", "alternative", "release", "parent", "comment"   — present only when defined
```

Callers MUST invoke it through `partialCached … (or $structure "") (or $bookshop "") (or $child "")`
(introduced for real in Task 12; direct `partial` is fine until then).

- [ ] **Step 1: Write the compiler**

Create `layouts/_partials/utilities/ArgsSchema.html`:

```go-html-template
<!--
    Copyright © 2026 The Hinode Team / Mark Dumay. All rights reserved.
    Use of this source code is governed by The MIT License (MIT) that can be found in the LICENSE file.
    Visit gethinode.com/license for more details.
-->

{{/*
    Compile the argument schema of a structure or bookshop component into a self-contained,
    recursive schema tree. The result is a pure function of the site's data files; invoke through
    partialCached keyed by the (structure, bookshop, child) triple. See the plan/spec for the
    node shape.
*/}}

{{ define "_partials/inline/camel-key.html" }}
    {{ $match := findRESubmatch "^(_*)(.*)$" . }}
    {{ $prefix := index $match 0 1 }}
    {{ $body := replaceRE "_" "-" (index $match 0 2) }}
    {{ $result := "" }}
    {{ range $index, $word := split $body "-" }}
        {{ if gt $index 0 }}
            {{ $result = print $result (strings.FirstUpper $word) }}
        {{ else }}
            {{ $result = strings.ToLower $word }}
        {{ end }}
    {{ end }}
    {{ return print $prefix $result }}
{{ end }}

{{ define "_partials/inline/compile-node.html" }}
    {{ $key := .key }}
    {{ $val := .val }}
    {{ $arguments := .arguments }}
    {{ $typesData := .typesData }}
    {{ $stack := .stack }}
    {{ $path := .path }}
    {{ $errmsg := slice }}

    {{/* normalize the key for the global lookup: snake_case → kebab-case, keep leading underscores */}}
    {{ $match := findRESubmatch "^(_*)(.*)$" $key }}
    {{ $normKey := print (index $match 0 1) (replaceRE "_" "-" (index $match 0 2)) }}

    {{/* merge the global definition with inline overrides from the structure file or blueprint */}}
    {{ $def := index $arguments $normKey | default dict }}
    {{ if reflect.IsMap $val }}
        {{ $def = merge $def $val }}
    {{ else if and (ne $val nil) (not (reflect.IsSlice $val)) }}
        {{ $def = merge $def (dict "default" $val) }}
    {{ end }}

    {{ if not $def.type }}
        {{ $errmsg = $errmsg | append (printf "schema: missing type for '%s'" $path) }}
        {{ return (dict "node" nil "errmsg" $errmsg) }}
    {{ end }}

    {{ $declared := slice | append $def.type }}
    {{ $accepts := slice }}
    {{ $kind := "scalar" }}
    {{ $children := dict }}
    {{ $udtType := "" }}
    {{ $udts := 0 }}

    {{ range $type := $declared }}
        {{ if in (slice "string" "path" "select" "url") $type }}
            {{ $accepts = $accepts | append "string" }}
        {{ else if eq $type "bool" }}
            {{ $accepts = $accepts | append "bool" }}
        {{ else if in (slice "int" "int64") $type }}
            {{ $accepts = $accepts | append "int" }}
        {{ else if in (slice "float" "float64") $type }}
            {{ $accepts = $accepts | append "float" "int" }}
        {{ else if eq $type "slice" }}
            {{ $kind = "list" }}
            {{ $accepts = $accepts | append "slice" "maplist" }}
        {{ else if eq $type "dict" }}
            {{/* legacy quirk kept on purpose: a generic dict accepts a map or a slice of maps */}}
            {{ $kind = "dict" }}
            {{ $accepts = $accepts | append "map" "maplist" }}
        {{ else }}
            {{ $shape := index $typesData $type }}
            {{ if eq $shape nil }}
                {{ $errmsg = $errmsg | append (printf "schema: unknown type '%s' for '%s'" $type $path) }}
            {{ else if in $stack $type }}
                {{ $errmsg = $errmsg | append (printf "schema: circular type reference '%s' for '%s'" $type $path) }}
            {{ else }}
                {{ $udts = add $udts 1 }}
                {{ $members := $shape }}
                {{ if reflect.IsSlice $shape }}
                    {{ $kind = "list" }}
                    {{ $accepts = $accepts | append "slice" "maplist" }}
                    {{ $members = index $shape 0 | default dict }}
                {{ else }}
                    {{ $kind = "dict" }}
                    {{ $accepts = $accepts | append "map" }}
                {{ end }}
                {{ if eq $udts 1 }}
                    {{ $udtType = $type }}
                    {{ range $member, $memberVal := $members }}
                        {{ $child := partial "inline/compile-node.html" (dict
                            "key"       $member
                            "val"       $memberVal
                            "arguments" $arguments
                            "typesData" $typesData
                            "stack"     ($stack | append $type)
                            "path"      (printf "%s.%s" $path $member)
                        ) }}
                        {{ $errmsg = $errmsg | append $child.errmsg }}
                        {{ with $child.node }}{{ $children = merge $children (dict $member .) }}{{ end }}
                    {{ end }}
                {{ end }}
            {{ end }}
        {{ end }}
    {{ end }}

    {{/* a union of multiple user-defined types is shape-checked only, not recursed */}}
    {{ if gt $udts 1 }}{{ $children = dict }}{{ $udtType = "" }}{{ end }}

    {{ $node := dict
        "name"     $key
        "camelKey" (partial "inline/camel-key.html" $key)
        "types"    $declared
        "accepts"  (uniq $accepts)
        "kind"     $kind
        "optional" (default false $def.optional)
    }}
    {{ if $children }}{{ $node = merge $node (dict "children" $children "udtType" $udtType) }}{{ end }}
    {{ if ne $def.default nil }}{{ $node = merge $node (dict "default" $def.default) }}{{ end }}
    {{ with $def.config }}{{ $node = merge $node (dict "config" .) }}{{ end }}
    {{ with $def.options }}{{ $node = merge $node (dict "options" .) }}{{ end }}
    {{ if isset $def "position" }}{{ $node = merge $node (dict "position" $def.position) }}{{ end }}
    {{ with $def.group }}{{ $node = merge $node (dict "group" (slice | append .)) }}{{ end }}
    {{ with $def.deprecated }}{{ $node = merge $node (dict "deprecated" (string .)) }}{{ end }}
    {{ with $def.alternative }}{{ $node = merge $node (dict "alternative" .) }}{{ end }}
    {{ with $def.release }}{{ $node = merge $node (dict "release" .) }}{{ end }}
    {{ with $def.parent }}{{ $node = merge $node (dict "parent" .) }}{{ end }}
    {{ with $def.comment }}{{ $node = merge $node (dict "comment" .) }}{{ end }}

    {{ return (dict "node" $node "errmsg" $errmsg) }}
{{ end }}

{{/* main body */}}
{{ $structure := .structure }}
{{ $bookshop := .bookshop }}
{{ $child := .child }}
{{ $errmsg := slice }}

{{ $arguments := ((index site.Data.structures "_arguments") | default dict).arguments | default dict }}
{{ $typesData := ((index site.Data.structures "_types") | default dict).types | default dict }}

{{/* assemble the raw argument map from the structure file or the bookshop blueprint + sidecar */}}
{{ $raw := dict }}
{{ if $structure }}
    {{ $raw = ((index site.Data.structures $structure) | default dict).arguments | default dict }}
{{ else if $bookshop }}
    {{ $component := index (site.Data.structures.components | default dict) $bookshop | default dict }}
    {{ $raw = (index $component (printf "%s.bookshop" $bookshop) | default dict).blueprint | default dict }}
    {{ $raw = merge $raw (dict "_bookshop_name" nil "_ordinal" nil "id" nil) }}
    {{ $sidecar := ((index $component $bookshop) | default dict).arguments | default dict }}
    {{ range $key, $def := $sidecar }}
        {{ if reflect.IsMap $def }}
            {{ $snakeKey := replaceRE "-" "_" $key }}
            {{ $target := cond (isset $raw $snakeKey) $snakeKey $key }}
            {{ $existing := index $raw $target }}
            {{ if not (reflect.IsMap $existing) }}
                {{/* intentional fix over legacy: a scalar blueprint value is the default — keep it */}}
                {{ $existing = cond (eq $existing nil) dict (dict "default" $existing) }}
            {{ end }}
            {{ $raw = merge $raw (dict $target (merge $existing $def)) }}
        {{ end }}
    {{ end }}
{{ else }}
    {{ $errmsg = $errmsg | append "schema: missing value for param 'structure' or 'bookshop'" }}
{{ end }}

{{/* merge parent-flagged arguments from the child structure, stripping their defaults */}}
{{ if $child }}
    {{ $extra := ((index site.Data.structures $child) | default dict).arguments }}
    {{ if not $extra }}
        {{ $errmsg = $errmsg | append (printf "schema: missing definitions: %s" $child) }}
    {{ else }}
        {{ range $key, $val := $extra }}
            {{ if and (reflect.IsMap $val) $val.parent }}
                {{ $clean := dict }}
                {{ range $k, $v := $val }}
                    {{ if ne $k "default" }}{{ $clean = merge $clean (dict $k $v) }}{{ end }}
                {{ end }}
                {{ $raw = merge $raw (dict $key $clean) }}
            {{ end }}
        {{ end }}
    {{ end }}
{{ end }}

{{/* compile each argument into a schema node */}}
{{ $schema := dict }}
{{ $positions := dict }}
{{ $name := or $structure $bookshop }}
{{ range $key, $val := $raw }}
    {{ $result := partial "inline/compile-node.html" (dict
        "key"       $key
        "val"       $val
        "arguments" $arguments
        "typesData" $typesData
        "stack"     slice
        "path"      (printf "%s.%s" $name $key)
    ) }}
    {{ $errmsg = $errmsg | append $result.errmsg }}
    {{ with $result.node }}
        {{ $schema = merge $schema (dict $key .) }}
        {{ if isset . "position" }}
            {{ $positions = merge $positions (dict (string .position) $key) }}
        {{ end }}
    {{ end }}
{{ end }}

{{ return (dict "schema" $schema "positions" $positions "err" (gt (len $errmsg) 0) "errmsg" $errmsg) }}
```

- [ ] **Step 2: Compile-error fixture**

A true cyclic-type fixture is NOT possible without editing the module's global `_arguments.yml`
(forbidden by the global constraints): UDT *members* resolve their types exclusively through the
global arguments file, so a test-only member can never point back to a test-only type. The
`$stack` cycle guard in `compile-node` therefore stays as a defensive invariant (it fires the day
a real cyclic type lands in the shipped data files, and costs nothing meanwhile) and is exercised
here only indirectly. Pin the two reachable compile-error classes instead — record this
limitation as a comment in the case file and in the spec deviation log (Task 11).

Append to `exampleSite/data/structures/_types.yml` (below the test marker):

```yaml
  test-node:
    title:
    member-without-global-def:
```

Create `exampleSite/data/structures/test-cycle.yml`:

```yaml
comment: >-
  Fixture for schema compile errors: a UDT member without a global argument definition
  ('schema: missing type') and an unknown type name ('schema: unknown type').
  A true circular type reference cannot be constructed from test-only data (members resolve
  through the module's global _arguments.yml); the compiler's stack guard is defensive.
arguments:
  root-node:
    type: test-node
    optional: true
  bogus-typed:
    type: no-such-type
    optional: true
```

- [ ] **Step 3: Extend the runner layout for schema cases**

In `exampleSite/layouts/tests/single.json`, replace the loop body with:

```go-html-template
{{- range $case := $data.cases -}}
    {{- $entry := dict -}}
    {{- if eq $case.api "schema" -}}
        {{- $compiled := partial "utilities/ArgsSchema.html" (dict
            "structure" ($case.structure | default "")
            "bookshop"  ($case.bookshop | default "")
            "child"     ($case.child | default "")
        ) -}}
        {{- $entry = dict "schema" $compiled -}}
    {{- else -}}
        {{- $params := dict
            "structure" ($case.structure | default "")
            "args"      $case.args
            "named"     (ne $case.named false)
        -}}
        {{- with $case.bookshop }}{{ $params = merge $params (dict "bookshop" . "structure" "") }}{{ end -}}
        {{- with $case.child }}{{ $params = merge $params (dict "child" .) }}{{ end -}}
        {{- with $case.group }}{{ $params = merge $params (dict "group" .) }}{{ end -}}
        {{- $entry = dict "initargs" (partial "utilities/InitArgs.html" $params) -}}
    {{- end -}}
    {{- $results = merge $results (dict $case.name $entry) -}}
{{- end -}}
```

- [ ] **Step 4: Schema case file**

Create `exampleSite/data/tests/schema.yml`:

```yaml
cases:
  - name: scalar-structure
    api: schema
    structure: test-cast
  - name: nested-structure
    api: schema
    structure: test-nested
  - name: child-merge
    api: schema
    structure: test-stack
    child: test-card
  - name: bookshop-blueprint
    api: schema
    bookshop: test-hero
  - name: compile-errors
    api: schema
    structure: test-cycle
  - name: positions
    api: schema
    structure: test-required
```

Create `exampleSite/content/tests/schema.md` (frontmatter pattern from Task 1 Step 3).

- [ ] **Step 5: Build, inspect the compiled schemas, commit**

```bash
pnpm test:update && pnpm test   # Expected: "golden check passed (11 groups)"
```

Inspect `tests/golden/schema.json` line by line against the node contract above. Must-holds:
`nested-structure` shows `heading.children.align` with `default: "start"` and
`locations.children.instructions.children.title` (depth-3 recursion); `child-merge` includes
`hook` WITHOUT a `default` field and excludes `ignored-non-parent`; `bookshop-blueprint` shows
snake declared names, `link_type` carrying the sidecar's select options AND the blueprint default
`button`, plus `_bookshop_name`/`_ordinal`/`id`; `compile-errors` has `err: true` with both
`schema:` messages; `positions` maps `"0" → name`, `"1" → kind`. No existing golden may change.

```bash
git add layouts exampleSite tests/golden
git commit -m "feat: add ArgsSchema compiler with recursive type resolution"
```

---

### Task 7: `Args.html` — clean entry point with recursive validator

**Files:**
- Create: `layouts/_partials/utilities/Args.html`
- Modify: `exampleSite/layouts/tests/single.json` (emit an `args` result next to `initargs`)

**Interfaces:**
- Consumes: `ArgsSchema.html` contract (Task 6).
- Produces:

```text
partial "utilities/Args.html" (dict
    "structure" S | "bookshop" B   [exactly one non-empty]
    "child" C  "args" MAP-or-SLICE  "named" bool(true)  "group" G  "strict" bool(true))
  → dict "args" (map camelKey → value), "err" bool, "errmsg" []string,
         "warnmsg" []string, "defaulted" []string (dotted paths)
```

Strictness classes: findings that legacy InitArgs could not detect (nested findings, i.e. depth > 0,
and top-level type/options findings on falsy values) are errors when `strict`, warnings otherwise.
Everything legacy already treated as an error stays an error in both modes.

- [ ] **Step 1: Write `Args.html`**

Create `layouts/_partials/utilities/Args.html`:

```go-html-template
<!--
    Copyright © 2026 The Hinode Team / Mark Dumay. All rights reserved.
    Use of this source code is governed by The MIT License (MIT) that can be found in the LICENSE file.
    Visit gethinode.com/license for more details.
-->

{{/*
    Validate and initialize arguments against a compiled schema (see utilities/ArgsSchema.html).
    Returns a separated envelope: user values never share a namespace with bookkeeping keys.
    Keys in "args" are camelCase (canonical); "defaulted" lists dotted paths of defaulted values.
*/}}

{{ define "_partials/inline/site-param.html" }}
    {{/* isset-based site-parameter lookup: an explicit false/0 value is found and honored */}}
    {{ $current := site.Params }}
    {{ $found := true }}
    {{ range $segment := split .path "." }}
        {{ if and $found (reflect.IsMap $current) (isset $current $segment) }}
            {{ $current = index $current $segment }}
        {{ else }}
            {{ $found = false }}
        {{ end }}
    {{ end }}
    {{ if not $found }}{{ $current = nil }}{{ end }}
    {{ return (dict "found" $found "value" $current) }}
{{ end }}

{{ define "_partials/inline/value-kind.html" }}
    {{/* map a value to its kind token: string, bool, int, float, map, slice, maplist, other */}}
    {{ $value := . }}
    {{ $type := printf "%T" $value }}
    {{ $kind := "other" }}
    {{ if eq $type "string" }}{{ $kind = "string" }}
    {{ else if eq $type "bool" }}{{ $kind = "bool" }}
    {{ else if in (slice "int" "int8" "int16" "int32" "int64" "uint" "uint8" "uint16" "uint32" "uint64") $type }}
        {{ $kind = "int" }}
    {{ else if in (slice "float32" "float64") $type }}{{ $kind = "float" }}
    {{ else if reflect.IsMap $value }}{{ $kind = "map" }}
    {{ else if reflect.IsSlice $value }}
        {{ $kind = "slice" }}
        {{ if gt (len $value) 0 }}
            {{ $maps := true }}
            {{ range $value }}{{ if not (reflect.IsMap .) }}{{ $maps = false }}{{ break }}{{ end }}{{ end }}
            {{ if $maps }}{{ $kind = "maplist" }}{{ end }}
        {{ end }}
    {{ end }}
    {{ return $kind }}
{{ end }}

{{ define "_partials/inline/validate-node.html" }}
    {{/*
        in:  value, node, path, name, depth (int), provided (bool)
        out: dict "value" (with defaults and casts applied; nil when absent without default),
             "errmsg" (errors in every mode), "newmsg" (newly detectable class: error when strict,
             warning in legacy mode), "warnmsg", "defaulted" (dotted paths)
    */}}
    {{ $value := .value }}
    {{ $node := .node }}
    {{ $path := .path }}
    {{ $name := .name }}
    {{ $depth := .depth }}
    {{ $provided := .provided }}
    {{ $errmsg := slice }}
    {{ $newmsg := slice }}
    {{ $warnmsg := slice }}
    {{ $defaulted := slice }}

    {{/* deprecation warning when the caller provided an actual value */}}
    {{ if and $provided $node.deprecated }}
        {{ $warn := printf "[%s] argument '%s': deprecated in v%s" $name $path (strings.TrimPrefix "v" $node.deprecated) }}
        {{ with $node.alternative }}{{ $warn = printf "%s, use '%s' instead" $warn . }}{{ end }}
        {{ $warnmsg = $warnmsg | append $warn }}
    {{ end }}

    {{/* default application: null/absent means "not provided" at every level */}}
    {{ if eq $value nil }}
        {{ $resolved := false }}
        {{ with $node.config }}
            {{ $lookup := partial "inline/site-param.html" (dict "path" .) }}
            {{ if $lookup.found }}{{ $value = $lookup.value }}{{ $resolved = true }}{{ end }}
        {{ end }}
        {{ if and (not $resolved) (isset $node "default") }}
            {{ $value = $node.default }}
            {{ $resolved = true }}
        {{ end }}
        {{ if $resolved }}
            {{ $defaulted = $defaulted | append $path }}
        {{ else if $node.children }}
            {{/* fill the shape of an absent user-defined type so templates can chain safely */}}
            {{ if eq $node.kind "list" }}
                {{ $value = slice }}
            {{ else }}
                {{ $shape := dict }}
                {{ range $member, $childNode := $node.children }}
                    {{ $childRes := partial "inline/validate-node.html" (dict
                        "value" nil "node" $childNode "path" (printf "%s.%s" $path $member)
                        "name" $name "depth" (add $depth 1) "provided" false) }}
                    {{ if ne $childRes.value nil }}
                        {{ $shape = merge $shape (dict $member $childRes.value) }}
                        {{ $defaulted = $defaulted | append $childRes.defaulted }}
                    {{ end }}
                {{ end }}
                {{ if $shape }}{{ $value = $shape }}{{ end }}
            {{ end }}
        {{ end }}
        {{ if eq $value nil }}
            {{ return (dict "value" nil "errmsg" $errmsg "newmsg" $newmsg "warnmsg" $warnmsg "defaulted" $defaulted) }}
        {{ end }}
    {{ end }}

    {{/* casting between strings and scalars */}}
    {{ $kind := partial "inline/value-kind.html" $value }}
    {{ if eq $kind "string" }}
        {{ if and (in $node.accepts "bool") (in (slice "true" "false") $value) }}
            {{ $value = eq $value "true" }}
            {{ $kind = "bool" }}
        {{ else if and (in $node.accepts "int") (findRE `^-?\d+$` $value) }}
            {{ $value = int $value }}
            {{ $kind = "int" }}
        {{ else if and (in $node.accepts "float") (findRE `^-?(\d+\.\d+|\.\d+)$` $value) }}
            {{ $value = float $value }}
            {{ $kind = "float" }}
        {{ end }}
    {{ else if and (in $node.accepts "string") (in (slice "bool" "int" "float") $kind) (not (in $node.accepts $kind)) }}
        {{ $value = string $value }}
        {{ $kind = "string" }}
    {{ end }}

    {{/* type check: applies to every provided value, including explicit false, 0, and "" */}}
    {{ if not (in $node.accepts $kind) }}
        {{ $msg := printf "[%s] argument '%s': expected type '%s', got '%s' with value '%v'"
            $name $path (delimit $node.types ", ") (printf "%T" .value) $value }}
        {{ if or (gt $depth 0) (not $value) }}
            {{ $newmsg = $newmsg | append $msg }}
        {{ else }}
            {{ $errmsg = $errmsg | append $msg }}
        {{ end }}
        {{ return (dict "value" $value "errmsg" $errmsg "newmsg" $newmsg "warnmsg" $warnmsg "defaulted" $defaulted) }}
    {{ end }}

    {{/* permitted values and numeric ranges */}}
    {{ if and (reflect.IsMap $node.options) $node.options.values (eq $kind "string") }}
        {{ if not (in $node.options.values $value) }}
            {{ $msg := printf "[%s] argument '%s': unexpected value '%s'" $name $path $value }}
            {{ if or (gt $depth 0) (not $value) }}
                {{ $newmsg = $newmsg | append $msg }}
            {{ else }}
                {{ $errmsg = $errmsg | append $msg }}
            {{ end }}
        {{ end }}
    {{ else if and (reflect.IsMap $node.options)
        (or (isset $node.options "min") (isset $node.options "max"))
        (in (slice "int" "float") $kind) }}
        {{ if or
            (and (isset $node.options "min") (lt $value $node.options.min))
            (and (isset $node.options "max") (gt $value $node.options.max)) }}
            {{ $min := string (or $node.options.min "-") }}
            {{ $max := string (or $node.options.max "-") }}
            {{ $msg := printf "[%s] argument '%s': value '%v' out of range [%s, %s]" $name $path $value $min $max }}
            {{ if or (gt $depth 0) (not $value) }}
                {{ $newmsg = $newmsg | append $msg }}
            {{ else }}
                {{ $errmsg = $errmsg | append $msg }}
            {{ end }}
        {{ end }}
    {{ end }}

    {{/* recursion into user-defined types */}}
    {{ if and $node.children (eq $kind "map") }}
        {{ $result := partial "inline/validate-members.html" (dict
            "value" $value "node" $node "path" $path "name" $name "depth" $depth) }}
        {{ $value = $result.value }}
        {{ $errmsg = $errmsg | append $result.errmsg }}
        {{ $newmsg = $newmsg | append $result.newmsg }}
        {{ $warnmsg = $warnmsg | append $result.warnmsg }}
        {{ $defaulted = $defaulted | append $result.defaulted }}
    {{ else if and $node.children (in (slice "maplist" "slice") $kind) }}
        {{ $elements := slice }}
        {{ range $index, $element := $value }}
            {{ if reflect.IsMap $element }}
                {{ $result := partial "inline/validate-members.html" (dict
                    "value" $element "node" $node
                    "path" (printf "%s[%d]" $path $index) "name" $name "depth" $depth) }}
                {{ $elements = $elements | append $result.value }}
                {{ $errmsg = $errmsg | append $result.errmsg }}
                {{ $newmsg = $newmsg | append $result.newmsg }}
                {{ $warnmsg = $warnmsg | append $result.warnmsg }}
                {{ $defaulted = $defaulted | append $result.defaulted }}
            {{ else }}
                {{ $newmsg = $newmsg | append (printf "[%s] argument '%s[%d]': expected map element, got '%T'" $name $path $index $element) }}
                {{ $elements = $elements | append $element }}
            {{ end }}
        {{ end }}
        {{ $value = $elements }}
    {{ end }}

    {{ return (dict "value" $value "errmsg" $errmsg "newmsg" $newmsg "warnmsg" $warnmsg "defaulted" $defaulted) }}
{{ end }}

{{ define "_partials/inline/validate-members.html" }}
    {{/* validate the members of one map value against node.children; fills member defaults */}}
    {{ $value := .value }}
    {{ $node := .node }}
    {{ $path := .path }}
    {{ $name := .name }}
    {{ $depth := .depth }}
    {{ $errmsg := slice }}
    {{ $newmsg := slice }}
    {{ $warnmsg := slice }}
    {{ $defaulted := slice }}
    {{ $out := dict }}

    {{ range $memberKey, $memberVal := $value }}
        {{ $childNode := index $node.children $memberKey }}
        {{ $declaredKey := $memberKey }}
        {{ if not $childNode }}
            {{/* content uses snake_case (bookshop) while members are declared kebab-case, or vice versa */}}
            {{ $match := findRESubmatch "^(_*)(.*)$" (string $memberKey) }}
            {{ $body := index $match 0 2 }}
            {{ $alt := print (index $match 0 1) (cond (strings.Contains $body "_") (replaceRE "_" "-" $body) (replaceRE "-" "_" $body)) }}
            {{ with index $node.children $alt }}
                {{ $childNode = . }}
                {{ $declaredKey = $alt }}
            {{ end }}
        {{ end }}
        {{ if not $childNode }}
            {{ $newmsg = $newmsg | append (printf "[%s] argument '%s': unsupported attribute '%s'" $name $path $memberKey) }}
            {{ $out = merge $out (dict (string $memberKey) $memberVal) }}
        {{ else }}
            {{ $childRes := partial "inline/validate-node.html" (dict
                "value" $memberVal "node" $childNode
                "path" (printf "%s.%s" $path $declaredKey)
                "name" $name "depth" (add $depth 1)
                "provided" (ne $memberVal nil)) }}
            {{ $errmsg = $errmsg | append $childRes.errmsg }}
            {{ $newmsg = $newmsg | append $childRes.newmsg }}
            {{ $warnmsg = $warnmsg | append $childRes.warnmsg }}
            {{ $defaulted = $defaulted | append $childRes.defaulted }}
            {{ if ne $childRes.value nil }}
                {{ $out = merge $out (dict $declaredKey $childRes.value) }}
            {{ end }}
        {{ end }}
    {{ end }}

    {{/* fill defaults for members the caller omitted entirely */}}
    {{ range $memberKey, $childNode := $node.children }}
        {{ $snake := replaceRE "-" "_" $memberKey }}
        {{ if and (not (isset $out $memberKey)) (not (isset $value $memberKey)) (not (isset $value $snake)) }}
            {{ $childRes := partial "inline/validate-node.html" (dict
                "value" nil "node" $childNode
                "path" (printf "%s.%s" $path $memberKey)
                "name" $name "depth" (add $depth 1) "provided" false) }}
            {{ if ne $childRes.value nil }}
                {{ $out = merge $out (dict $memberKey $childRes.value) }}
                {{ $defaulted = $defaulted | append $childRes.defaulted }}
            {{ end }}
        {{ end }}
    {{ end }}

    {{ return (dict "value" $out "errmsg" $errmsg "newmsg" $newmsg "warnmsg" $warnmsg "defaulted" $defaulted) }}
{{ end }}

{{/* main body */}}
{{ $structure := .structure }}
{{ $bookshop := .bookshop }}
{{ $child := .child }}
{{ $named := .named | default true }}
{{ $args := .args | default dict }}
{{ $group := .group }}
{{ $strict := ne .strict false }}

{{ $errmsg := slice }}
{{ $newmsg := slice }}
{{ $warnmsg := slice }}
{{ $defaulted := slice }}
{{ $out := dict }}
{{ $name := or $structure $bookshop }}

{{ $compiled := partial "utilities/ArgsSchema.html" (dict "structure" $structure "bookshop" $bookshop "child" $child) }}
{{ if $compiled.err }}
    {{ $errmsg = $errmsg | append $compiled.errmsg }}
{{ else }}
    {{ $schema := $compiled.schema }}

    {{/* map positional arguments to their declared names */}}
    {{ $provided := dict }}
    {{ if $named }}
        {{ $provided = $args }}
    {{ else }}
        {{ range $index, $val := $args }}
            {{ with index $compiled.positions (string $index) }}
                {{ $provided = merge $provided (dict . $val) }}
            {{ else }}
                {{ $errmsg = $errmsg | append (printf "[%s] unsupported argument at index %d (value: '%s')" $name $index $val) }}
            {{ end }}
        {{ end }}
    {{ end }}

    {{/* normalize provided keys to declared names; collect all unknown-argument errors */}}
    {{ $normalized := dict }}
    {{ range $key, $val := $provided }}
        {{ if eq $key "_default" }}
            {{ $defaulted = $defaulted | append $val }}
        {{ else }}
            {{ $declared := string $key }}
            {{ if and (not (isset $schema $declared)) $bookshop }}
                {{ $match := findRESubmatch "^(_*)(.*)$" $declared }}
                {{ $body := index $match 0 2 }}
                {{ $alt := print (index $match 0 1) (cond (strings.Contains $body "_") (replaceRE "_" "-" $body) (replaceRE "-" "_" $body)) }}
                {{ if isset $schema $alt }}{{ $declared = $alt }}{{ end }}
            {{ end }}
            {{ if and $bookshop (strings.Contains (string $key) "-") (isset $schema $declared) }}
                {{ $warnmsg = $warnmsg | append (printf "[%s] argument '%s': prefer snake_case '%s'" $name $key (replaceRE "-" "_" (string $key))) }}
            {{ end }}
            {{ if not (isset $schema $declared) }}
                {{ $errmsg = $errmsg | append (printf "[%s] unsupported argument '%s'" $name $key) }}
            {{ else }}
                {{ $normalized = merge $normalized (dict $declared $val) }}
            {{ end }}
        {{ end }}
    {{ end }}

    {{/* validate every schema argument and enforce required ones */}}
    {{ range $key, $node := $schema }}
        {{ $isProvided := isset $normalized $key }}
        {{ $val := index $normalized $key }}
        {{ $res := partial "inline/validate-node.html" (dict
            "value" $val "node" $node "path" $key "name" $name
            "depth" 0 "provided" (and $isProvided (ne $val nil))) }}
        {{ $errmsg = $errmsg | append $res.errmsg }}
        {{ $newmsg = $newmsg | append $res.newmsg }}
        {{ $warnmsg = $warnmsg | append $res.warnmsg }}
        {{ $defaulted = $defaulted | append $res.defaulted }}
        {{ if ne $res.value nil }}
            {{ $out = merge $out (dict $node.camelKey $res.value) }}
        {{ end }}

        {{ $skip := false }}
        {{ if and $group $node.group }}{{ $skip = not (in $node.group $group) }}{{ end }}
        {{ if and (not $skip) (not $node.optional) (not $isProvided) }}
            {{ $errmsg = $errmsg | append (printf "[%s] argument '%s': expected value" $name $key) }}
        {{ end }}
    {{ end }}
{{ end }}

{{ if $strict }}
    {{ $errmsg = $errmsg | append $newmsg }}
{{ else }}
    {{ $warnmsg = $warnmsg | append $newmsg }}
{{ end }}
{{ return (dict
    "args" $out
    "err" (gt (len $errmsg) 0)
    "errmsg" $errmsg
    "warnmsg" $warnmsg
    "defaulted" $defaulted
) }}
```

- [ ] **Step 2: Emit the strict result next to the legacy result in the runner**

In `exampleSite/layouts/tests/single.json`, in the non-schema branch, after computing `$entry`,
add the strict-core result so every case golden shows both APIs side by side:

```go-html-template
        {{- $strict := partial "utilities/Args.html" (merge $params (dict "strict" true)) -}}
        {{- $entry = merge $entry (dict "args" $strict) -}}
```

- [ ] **Step 3: Build, review the golden diff exhaustively**

```bash
pnpm exec hugo -s exampleSite 2>&1 | head -20   # fix template syntax errors first
pnpm test                                        # Expected: DIFFs — every group gains an "args" key
pnpm test:update && pnpm test                    # Expected: "golden check passed (11 groups)"
git diff tests/golden
```

Review checklist (each item = intended target semantics; anything else is a bug in `Args.html`):
- Every existing `initargs` object is **byte-identical** to before — this step may only ADD `args` keys. Any `initargs` drift means `Args.html` accidentally leaked into the legacy path.
- `envelope/default-arg-collision`: `args.args.default` is `"user-value"` (collision fixed in the clean envelope).
- `defaults/config-false-fallthrough`: strict result shows `fromConfigFalse: false` (BUG(4) fixed).
- `casting/falsy-wrong-type-skips-validation`: strict result has the type error in `errmsg` (BUG(3) fixed).
- `nesting/absent-udt-shape-fill`: strict shows `heading.align: "start"`, `heading.width: 8` — each child's own default (BUG(1) fixed) — and `defaulted` contains `heading.align`, `heading.width`.
- `nesting/nested-wrong-type-passes` and `nested-unknown-key-passes`: strict `errmsg` non-empty (BUG(2) fixed; depth > 0 findings are errors when strict).
- `required/first-error-wins`: strict `errmsg` has BOTH unsupported-argument entries (BUG(6) fixed).
- `bookshop/cloudcannon-null-heavy`: strict `err: false` — nulls stay tolerated (spec §1.3.3).
- `bookshop/cloudcannon-explicit-false`: `show_more`/`width` validated but valid → `err: false`; keys appear camelCased (`showMore`).
- `frontmatter/params-typed-nested-map`: strict handles `maps.Params` without a type error.

- [ ] **Step 4: Commit**

```bash
git add layouts exampleSite tests/golden
git commit -m "feat: add Args entry point with recursive validation

- Fixes nested defaults, zero-deep validation, falsy-value skips, and
  or-based config fallthrough on the strict path (spec defects 1-4, 6)
- Adds side-by-side strict results to every golden group"
```

---

### Task 8: Rewire `InitArgs.html` as a compatibility shim

**Files:**
- Modify: `layouts/_partials/utilities/InitArgs.html` (full replacement)

**Interfaces:**
- Consumes: `Args.html` (strict=false) and `ArgsSchema.html` (declared-name ↔ camelKey mapping).
- Produces: the legacy contract — flat map of argument values under declared names plus camelCase
  duplicates, merged with `err`, `errmsg`, `warnmsg`, `default` (top-level defaulted names +
  `_default` pass-through values).

- [ ] **Step 1: Replace the body of `InitArgs.html`**

```go-html-template
<!--
    Copyright © 2024 - 2026 The Hinode Team / Mark Dumay. All rights reserved.
    Use of this source code is governed by The MIT License (MIT) that can be found in the LICENSE file.
    Visit gethinode.com/license for more details.
-->

{{/*
    Compatibility shim over utilities/Args.html. Preserves the legacy flat return map: argument
    values under their declared names plus camelCase duplicates, merged with the bookkeeping keys
    err, errmsg, warnmsg, and default. New code should call utilities/Args.html directly.
*/}}

{{ $structure := .structure }}
{{ $bookshop := .bookshop }}
{{ $child := .child }}
{{ $named := .named | default true }}
{{ $args := .args | default dict }}
{{ $group := .group }}

{{ $error := false }}
{{ $errmsg := slice }}
{{ $warnmsg := slice }}
{{ $params := dict }}
{{ $default := slice }}

{{ if and (not $structure) (not $bookshop) }}
    {{ $errmsg = $errmsg | append (printf "partial [utilities/InitArgs.html] - Missing value for param 'structure' or 'bookshop'") }}
    {{ $error = true }}
{{ else }}
    {{ if hasPrefix $structure "bookshop-" }}
        {{ $bookshop = strings.TrimPrefix "bookshop-" $structure }}
        {{ $structure = "" }}
    {{ end }}

    {{ $res := partial "utilities/Args.html" (dict
        "structure" $structure
        "bookshop"  $bookshop
        "child"     $child
        "args"      $args
        "named"     $named
        "group"     $group
        "strict"    false
    ) }}
    {{ $error = $res.err }}
    {{ $errmsg = $res.errmsg }}
    {{ $warnmsg = $res.warnmsg }}

    {{ if not $error }}
        {{ $compiled := partial "utilities/ArgsSchema.html" (dict "structure" $structure "bookshop" $bookshop "child" $child) }}
        {{ range $key, $node := $compiled.schema }}
            {{ $val := index $res.args $node.camelKey }}
            {{ if ne $val nil }}
                {{ $params = merge $params (dict $key $val) }}
                {{ if ne $node.camelKey $key }}
                    {{ $params = merge $params (dict $node.camelKey $val) }}
                {{ end }}
            {{ end }}
        {{ end }}
        {{ range $res.defaulted }}
            {{ if not (strings.Contains . ".") }}{{ $default = $default | append . }}{{ end }}
        {{ end }}
    {{ end }}
{{ end }}

{{ $params = merge $params (dict "err" $error "errmsg" $errmsg "warnmsg" $warnmsg "default" $default) }}
{{ return $params }}
```

- [ ] **Step 2: Build and review the golden diff — the decisive gate of the whole effort**

```bash
pnpm test           # Expected: DIFFs in the initargs halves
git --no-pager diff # nothing yet — inspect the console diff, then:
pnpm test:update && git diff tests/golden
```

Every changed `initargs` line must belong to one of these INTENDED categories — anything else
means the shim diverges and must be fixed before committing:

1. **BUG(1) fix:** `nesting/absent-udt-shape-fill` now shows real child defaults
   (`align: "start"`, `width: 8`) instead of nulls.
2. **New warnings (strictness downgraded):** nested findings and falsy-value type findings appear
   in `warnmsg` (NOT `errmsg`) with `err: false` — e.g. `casting/falsy-wrong-type-skips-validation`,
   `nesting/nested-wrong-type-passes`, `nested-unknown-key-passes`.
3. **BUG(6) fix:** `required/first-error-wins` reports both errors.
4. **BUG(4) fix:** `defaults/config-false-fallthrough` honors the explicit false site param.
5. **Additive camelCase keys:** snake_case arguments now ALSO appear under camelCase keys
   (legacy only duplicated hyphenated names). Additive only — the snake keys must remain.
6. **Nulls dropped from nested maps:** provided-but-null members no longer appear as explicit
   nulls inside nested values (they were pass-through before). `err` must remain false.
7. **Sidecar default preserved:** bookshop args whose blueprint scalar default was previously
   discarded by the sidecar merge now show that default.
8. **Envelope collision:** `envelope/default-arg-collision` — the bookkeeping `default` slice still
   wins in the legacy map (collision is inherent to the flat envelope; only `Args.html` fixes it).
   If the legacy value changed shape here, reconcile against the Task 1 golden.
9. **Error-case payloads:** legacy broke on the first error and returned the arguments it had
   already processed; the shim returns only bookkeeping keys when `err` is true. Callers bail on
   `err` before touching values, so this payload difference is inert — but it WILL show in the
   goldens of error cases.

Also confirm: `bookshop/cloudcannon-null-heavy` still `err: false`; `child/child-args-cascade`
unchanged except intended categories; NO change in any `args` (strict) half.

- [ ] **Step 3: Integration smoke test against Hinode**

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode
HUGO_MODULE_REPLACEMENTS="github.com/gethinode/mod-utils/v5 -> /Users/mark/Development/GitHub/gethinode/mod-utils" \
  hugo --ignoreVendorPaths "github.com/gethinode/mod-utils/**" -s exampleSite -d /tmp/hinode-smoke --printI18nWarnings 2>&1 | tee /tmp/hinode-smoke.log
cd /Users/mark/Development/GitHub/gethinode/mod-utils
```

Expected: build SUCCEEDS. Grep `/tmp/hinode-smoke.log` for `WARN`: new warnings from the
downgraded strictness classes are expected and must be listed in the commit body (they are the
"warnings-first" payload); any ERROR is a shim bug — fix before committing.

- [ ] **Step 4: Commit**

```bash
git add layouts tests/golden exampleSite
git commit -m "refactor: rewire InitArgs as a compatibility shim over Args

BREAKING-ISH (warnings only): newly detectable validation findings
(nested type mismatches, unknown nested attributes, falsy-value type
mismatches) surface as warnings; promotion to errors follows one
release cycle later per the design spec.

Golden diffs in this commit are intentional: nested defaults fixed,
all errors reported (no first-error break), explicit-false site
params honored, camelCase duplicates added for snake_case keys.

<list the new Hinode exampleSite warnings observed in the smoke test>"
```

---

### Task 9: Rewire `InitTypes.html` as a compatibility shim

**Files:**
- Modify: `layouts/_partials/utilities/InitTypes.html` (full replacement)
- Create: `exampleSite/data/tests/inittypes.yml`, `exampleSite/content/tests/inittypes.md`
- Modify: `exampleSite/layouts/tests/single.json` (support `api: inittypes`)

**Interfaces:**
- Consumes: `ArgsSchema.html`.
- Produces: legacy contract used by Hinode's `assets/args.html` (verified consumer):
  `{types: map name → legacy def, udt: map TYPE-name → {_reflect, member → legacy def}, err, errmsg, warnmsg}`.
  Legacy def fields: `type` (string when single, slice when union), `optional`, and — when defined —
  `default`, `config`, `options`, `position`, `group` (string when single), `deprecated`,
  `alternative`, `release`, `parent`, `comment`. `_reflect` is `"map[string]interface {}"` for dict
  UDTs and `"[]interface {}"` for list UDTs (matches `assets/args.html:41`). Only top-level UDTs
  appear in `udt` (legacy behavior — nested UDTs of members are not lifted).

- [ ] **Step 1: Add the characterization group FIRST (against the legacy implementation)**

Extend the runner layout's case dispatch with an `inittypes` branch (mirroring the `schema` branch):

```go-html-template
    {{- else if eq $case.api "inittypes" -}}
        {{- $entry = dict "inittypes" (partial "utilities/InitTypes.html" (dict
            "structure" ($case.structure | default "")
            "bookshop"  ($case.bookshop | default "")
            "child"     ($case.child | default "")
        )) -}}
```

Create `exampleSite/data/tests/inittypes.yml`:

```yaml
cases:
  - name: scalar-structure
    api: inittypes
    structure: test-cast
  - name: nested-structure
    api: inittypes
    structure: test-nested
  - name: bookshop-component
    api: inittypes
    bookshop: test-hero
  - name: child-merge
    api: inittypes
    structure: test-stack
    child: test-card
```

Create `exampleSite/content/tests/inittypes.md` (frontmatter pattern from Task 1 Step 3). Then:

```bash
pnpm test:update && pnpm test   # Expected: "golden check passed (12 groups)"
git add exampleSite tests/golden
git commit -m "test: characterize the legacy InitTypes contract"
```

- [ ] **Step 2: Replace `InitTypes.html`**

```go-html-template
<!--
    Copyright © 2025 - 2026 The Hinode Team / Mark Dumay. All rights reserved.
    Use of this source code is governed by The MIT License (MIT) that can be found in the LICENSE file.
    Visit gethinode.com/license for more details.
-->

{{/*
    Compatibility shim over utilities/ArgsSchema.html. Reproduces the legacy return shape
    {types, udt, err, errmsg, warnmsg}. Deprecated: new code should consume ArgsSchema directly.
*/}}

{{ define "_partials/inline/legacy-def.html" }}
    {{ $node := . }}
    {{ $type := $node.types }}
    {{ if eq (len $node.types) 1 }}{{ $type = index $node.types 0 }}{{ end }}
    {{ $def := dict "type" $type "optional" $node.optional }}
    {{ range $field := slice "default" "config" "options" "position" "deprecated" "alternative" "release" "parent" "comment" }}
        {{ if isset $node $field }}{{ $def = merge $def (dict $field (index $node $field)) }}{{ end }}
    {{ end }}
    {{ with $node.group }}
        {{ $group := . }}
        {{ if eq (len .) 1 }}{{ $group = index . 0 }}{{ end }}
        {{ $def = merge $def (dict "group" $group) }}
    {{ end }}
    {{ return $def }}
{{ end }}

{{ $compiled := partial "utilities/ArgsSchema.html" (dict
    "structure" (.structure | default "")
    "bookshop"  (.bookshop | default "")
    "child"     (.child | default "")
) }}

{{ $types := dict }}
{{ $udt := dict }}
{{ range $key, $node := $compiled.schema }}
    {{ $types = merge $types (dict $key (partial "inline/legacy-def.html" $node)) }}
    {{ if $node.children }}
        {{ $reflect := "map[string]interface {}" }}
        {{ if eq $node.kind "list" }}{{ $reflect = "[]interface {}" }}{{ end }}
        {{ $members := dict "_reflect" $reflect }}
        {{ range $member, $childNode := $node.children }}
            {{ $members = merge $members (dict $member (partial "inline/legacy-def.html" $childNode)) }}
        {{ end }}
        {{ $udt = merge $udt (dict $node.udtType $members) }}
    {{ end }}
{{ end }}

{{ return (dict "types" $types "udt" $udt "err" $compiled.err "errmsg" $compiled.errmsg "warnmsg" slice) }}
```

- [ ] **Step 3: Diff against the Step 1 characterization, reconcile, commit**

```bash
pnpm test && true; pnpm test:update && git diff tests/golden/inittypes.json
```

Reconcile every diff: acceptable categories are (a) messages now carrying the `schema:` prefix,
(b) field ordering inside defs (jsonify sorts — should be nil diff), (c) the sidecar-default fix
from Task 6. Legacy `udt` was keyed by TYPE name with `_reflect` — verify `nested-structure`
shows `udt.heading._reflect == "map[string]interface {}"` and `udt.locations._reflect == "[]interface {}"`.
Then rebuild the Hinode smoke test (same command as Task 8 Step 3) and additionally check a docs
page that uses the args table renders: grep the build log for errors mentioning `args.html`.

```bash
git add layouts tests/golden
git commit -m "refactor: rewire InitTypes as a compatibility shim over ArgsSchema"
```

---

### Task 10: Enable `partialCached` for schema compilation and measure

**Files:**
- Modify: `layouts/_partials/utilities/Args.html` (one call site)
- Modify: `layouts/_partials/utilities/InitArgs.html` (one call site)
- Modify: `layouts/_partials/utilities/InitTypes.html` (one call site)

**Interfaces:** unchanged signatures; `ArgsSchema.html` is now invoked as
`partialCached "utilities/ArgsSchema.html" $opts (or $structure "") (or $bookshop "") (or $child "")`.

- [ ] **Step 1: Capture the BEFORE metrics**

```bash
cd /Users/mark/Development/GitHub/gethinode/hinode
HUGO_MODULE_REPLACEMENTS="github.com/gethinode/mod-utils/v5 -> /Users/mark/Development/GitHub/gethinode/mod-utils" \
  hugo --ignoreVendorPaths "github.com/gethinode/mod-utils/**" -s exampleSite -d /tmp/hinode-metrics \
  --templateMetrics 2>&1 | grep -E "cumulative|InitArgs|InitTypes|ArgsSchema|Args.html" | head -20 | tee /tmp/metrics-before.txt
cd /Users/mark/Development/GitHub/gethinode/mod-utils
```

- [ ] **Step 2: Switch the three call sites**

In each of `Args.html`, `InitArgs.html`, `InitTypes.html`, replace the
`partial "utilities/ArgsSchema.html" (dict …)` invocation with:

```go-html-template
{{ $compiled := partialCached "utilities/ArgsSchema.html"
    (dict "structure" $structure "bookshop" $bookshop "child" $child)
    (or $structure "") (or $bookshop "") (or $child "") }}
```

(In `InitTypes.html` the option values are the `.structure | default ""` forms already computed —
bind them to variables first so the cache variants are plain strings.)

- [ ] **Step 3: Verify zero behavior drift, capture AFTER metrics**

```bash
pnpm test    # Expected: "golden check passed (12 groups)" — caching must not change ANY golden
```

Re-run the Step 1 metrics command into `/tmp/metrics-after.txt`. Expected: `ArgsSchema.html`
cumulative time drops sharply (cache hits); record both numbers in the commit body.

- [ ] **Step 4: Commit**

```bash
git add layouts
git commit -m "perf: cache compiled argument schemas per structure

Hinode exampleSite --templateMetrics, ArgsSchema.html cumulative:
before <X>, after <Y>."
```

---

### Task 11: Documentation and release preparation

**Files:**
- Modify: `README.md` (document `Args.html`, `ArgsSchema.html`, shim status of `InitArgs`/`InitTypes`, the null-vs-explicit semantics, and the warnings-first strictness rollout)
- Modify: `docs/superpowers/specs/2026-07-12-args-type-system-redesign-design.md` (status: Implemented (phases 0–4); record deviations discovered during execution, e.g. the cycle-fixture limitation from Task 6 Step 2)

- [ ] **Step 1: Write the README section**

Add under a `## Argument validation` heading: the `Args.html` signature and envelope, the
`ArgsSchema.html` node contract (copy from Task 6 Interfaces), a migration note ("InitArgs and
InitTypes remain supported as shims within v5"), the null-tolerance rule, and the list of warning
classes that will become errors after one release cycle.

- [ ] **Step 2: Full verification**

```bash
pnpm test                     # golden check passed (12 groups)
pnpm build                    # exampleSite builds clean
```

Re-run the Hinode smoke build (Task 8 Step 3) one final time; confirm warnings unchanged since Task 8.

- [ ] **Step 3: Commit and open the PR**

```bash
git add README.md docs
git commit -m "docs: document the Args validation API and strictness rollout"
git push -u origin HEAD
gh pr create --repo gethinode/mod-utils --base main \
  --title "feat: redesign argument and type system (core + shims, golden-tested)" \
  --body "<summarize: spec link, defect fixes, warnings-first rollout, metrics numbers>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Deferred (explicitly OUT of this plan — spec phase 5)

- Migrating Hinode/first-party module call sites to `Args.html`.
- `args.md` docs shortcode consuming `ArgsSchema`.
- Seeding mod-blocks' exampleSite with representative block content.
- Promoting the downgraded warning classes to errors (one release cycle later).
- Manual CloudCannon live-editing verification on a connected site (release gate, human task).
