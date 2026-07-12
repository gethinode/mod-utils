# Design: Argument and Type System Redesign (core + shim)

- **Date:** 2026-07-12
- **Status:** Draft — pending user review
- **Scope:** mod-utils v5 (`InitArgs.html`, `InitTypes.html`, and supporting data files)
- **Consumers affected:** ~160 call sites across Hinode, mod-blocks, and 13+ other
  modules; docs generation (`args.md` shortcode in Hinode); Bookshop blueprint and
  sidecar merging; derived public and private themes.

## 1. Context and problem statement

The argument and type system in mod-utils validates arguments passed to shortcodes,
partials, and Bookshop components across the Hinode ecosystem. It also powers
documentation generation and structured logging. The implementation
(`layouts/_partials/utilities/InitArgs.html`, ~270 lines, and
`layouts/_partials/utilities/InitTypes.html`, ~155 lines) has grown through many
incremental refactors — roughly 20 `fix:` commits touch `InitArgs.html` alone — and
none of those fixes shipped with a regression test. The exampleSite is a stub and CI
only verifies that it builds.

Nested argument types (user-defined types, "UDTs", declared in
`data/structures/_types.yml`) are the weakest area: initialization is bounded to one
level of nesting and validation of nested members effectively does not happen at all.

### 1.1 Defect and design-debt inventory (current state)

Confirmed by code inspection; each item becomes a characterization or regression test
in the new harness.

1. **Nested defaults use the parent's default** — `InitArgs.html:250-253`. When
   filling defaults for a missing UDT argument, the loop iterates child definitions
   (`$k`, `$v`) but passes the *parent's* `$val.config` / `$val.default` for every
   child key. Nested defaults are populated with the wrong values.
2. **Nested validation is zero-deep.** Validation compares only the top-level
   reflected Go type (`printf "%T"`). Members inside a `heading`, `items`,
   `locations`, etc. are never type-checked, never receive select/range validation,
   and unknown nested keys pass silently. Only default-filling attempts one level.
3. **Falsy values skip type validation** — `InitArgs.html:165`
   (`if and $val (not (in $expected $actual))`). An argument explicitly set to
   `false`, `0`, or `""` is never type-checked.
4. **`or`-based config fallthrough** — inline partial `default.html`
   (`InitArgs.html:7-11`) uses `or (index site.Params $config) $default`, so a site
   parameter explicitly set to `false` or `0` is ignored in favor of the static
   default. This is the exact pitfall Hinode's own documentation warns shortcode
   authors about.
5. **Return-envelope namespace collision.** The returned map merges user arguments
   with `err`, `errmsg`, `warnmsg`, and `default`. An argument named `default` (or
   `err`, …) would silently collide. Currently latent — only the meta-structure
   `_args.yml` uses these names — but it constrains the argument namespace forever.
6. **First error wins** — `break` on the first invalid argument hides all subsequent
   problems; authors fix errors one build at a time.
7. **No caching.** `InitTypes.html` re-derives the full type map from
   `site.Data.structures` on every `InitArgs` call: ~160 call sites × N instances
   per page × pages. The derivation is pure per structure name, so it is cacheable.
8. **camelCase duplication.** Every kebab-case key is duplicated in camelCase in the
   returned map, roughly doubling map size and creating two sources of truth.
9. **Flat UDT namespace, last-alias-wins** — `InitTypes.html:57` overwrites `$udt`
   inside the alias loop; nested UDT names must be globally unique.
10. **Misc:** `findRE` casting applied to non-string values; the float regex accepts
    the empty string; the `dict` type aliases to `[]map[string]interface {}` (a
    slice of maps), which is surprising; positional-argument matching is O(n²);
    the "without recursion" comment on `type-definition.html` is false (it is
    recursive).

### 1.2 What must keep working

Three consumers share the YAML contract and must stay coherent:

- **Runtime validation** — `InitArgs` call sites (shortcodes, partials, Bookshop
  wrappers) with `structure`, `bookshop`, `child`, `named`, `group` arguments.
- **Documentation generation** — Hinode's `args.md` shortcode reads the same
  structure files (global `_arguments.yml` merged with per-structure files and
  Bookshop blueprints) to render argument tables.
- **Bookshop / CloudCannon tooling** — component blueprints (`*.bookshop.yml`),
  sidecar augmentation files, snake_case/kebab-case key normalization, and the
  `_bookshop_name` / `_ordinal` / `id` implicit arguments.

## 2. Decisions (agreed with maintainer)

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Compatibility strategy | **B — new clean core inside v5, `InitArgs`/`InitTypes` become thin compatibility shims.** No v6 module-path break; no lockstep migration. |
| D2 | Nesting depth | **Fully recursive** validation and initialization (arbitrary depth, incl. UDT→UDT such as `locations → instructions`). |
| D3 | Test approach | **Golden-file harness** in mod-utils' exampleSite, characterization-first. |
| D4 | Performance | **In scope** — cache compiled schemas with `partialCached`. |
| D5 | Canonical keys in clean API | **camelCase only** in the `Args.html` envelope; the shim keeps today's duplicated spellings. |
| D6 | Unknown nested keys | **Error in strict mode** (consistent with top-level), warnings-first during transition. |
| D7 | Strictness rollout | Newly detectable error classes ship as **warnings for one release cycle** via the shim, then are promoted to errors. |

### 2.1 Non-goals

- No change to the YAML schema of `_arguments.yml`, `_types.yml`, structure files,
  Bookshop blueprints, or sidecars.
- No migration of call sites in Hinode or other modules (separate follow-up effort).
- No change to `args.md` docs generation (follow-up: consume the compiled schema).
- No mod-utils v6 / module-path change.

## 3. Architecture

Two concerns, currently interleaved, are separated:

1. **What is the contract?** → schema compilation (pure function of site data,
   cacheable).
2. **Does this value meet it?** → validation (recursive walk of value against
   schema).

```text
YAML sources                          per call
┌──────────────────┐   partialCached  ┌─────────────────────────┐
│ _arguments.yml   │  ┌────────────►  │ utilities/Args.html      │
│ _types.yml       │  │               │  - positional mapping    │
│ <structure>.yml  ├──┤ utilities/    │  - inline/validate.html  │
│ bookshop bluep.  │  │ ArgsSchema    │    (recursive walker)    │
│ sidecar files    │  │ .html         │  - envelope assembly     │
│ child structures │  └─────────────  └───────────┬─────────────┘
└──────────────────┘                              │ clean envelope
                                     ┌────────────▼─────────────┐
                                     │ utilities/InitArgs.html   │
                                     │ (compat shim: flatten,    │
                                     │  legacy keys, downgrade   │
                                     │  new errors to warnings)  │
                                     └──────────────────────────┘
```

### 3.1 `utilities/ArgsSchema.html` — schema compiler

- **Invocation:** `partialCached … (dict "structure" S "bookshop" B "child" C) S B C`
  — cached per `(structure, bookshop, child)` triple. `group` is *not* part of the
  key; group filtering happens at validation time.
- **Inputs merged (existing semantics preserved):** global `_arguments.yml` →
  `_types.yml` → per-structure file → Bookshop blueprint + implicit args
  (`_bookshop_name`, `_ordinal`, `id`) + sidecar augmentation → child structure
  arguments (`parent`-flagged, `default` stripped).
- **Output:** `{ schema: <map of argument name → node>, err, errmsg }`.
- **Schema node shape** (self-contained; no lookups needed at validation time):

  ```text
  node = {
    types:      []string   # normalized accepted reflect-types + primitive names
    kind:       "scalar" | "dict" | "list"   # structural kind for the walker
    default:    any        # optional
    config:     string     # optional dotted site-param path
    options:    { values | min | max }       # optional
    optional:   bool
    position:   int        # optional, top level only
    group:      []string   # optional
    deprecated: string     # optional; with alternative, release
    camelKey:   string     # precomputed canonical access key
    children:   { name → node }   # recursive, for dict/list-of-dict UDTs
  }
  ```

- Type aliases (`path`/`select`/`url` → string, `dict`, `slice`) are resolved during
  compilation, once. UDT references recurse with **cycle detection** (a UDT
  referencing itself or an ancestor reports a compile error instead of recursing
  forever).
- Compile-time problems (missing type definition, unknown UDT reference, cycles) are
  reported once per structure with a `schema:` prefix to distinguish them from
  caller errors.

### 3.2 `inline/validate.html` — recursive walker

- **Invocation (internal):** `(dict "value" V "node" N "path" "heading.title"
  "strict" bool "site" …)` → `{ value, errmsg, warnmsg, defaulted }`.
- **Per node, in order:**
  1. **Default application** when value is nil: `config` lookup first using
     isset-style traversal (an explicit `false`/`0` site param is honored — fixes
     defect 4), then `default`.
  2. **Casting:** string→bool/int/float and scalar→string, guarded so regex-based
     casts only run on actual strings (fixes defect 10a).
  3. **Type check** against `node.types` — *always*, including falsy values
     (fixes defect 3).
  4. **Options:** select values for strings; min/max for numerics.
  5. **Deprecation warning** when the argument was explicitly provided.
  6. **Recursion:** for `kind: dict`, validate each provided member against
     `children`, flag unknown members (error in strict, warning otherwise — D6),
     and fill member defaults (each child's *own* default — fixes defect 1). For
     `kind: list`, validate every element likewise (fixes defect 2).
- All problems are collected; the walker never breaks early (fixes defect 6).
  Messages carry the full path: `[card] argument 'heading.title': expected type
  'string', got 'int' with value '5'`.

### 3.3 `utilities/Args.html` — clean entry point

- **Signature:**

  ```text
  partial "utilities/Args.html" (dict
    "structure" S | "bookshop" B     # exactly one required
    "child"     C                    # optional
    "args"      .Params              # map (named) or slice (positional)
    "named"     true|false           # default true
    "group"     "shortcode"|"partial"|…   # optional required-arg filter
    "strict"    true|false           # default true
  )
  ```

- **Returns a separated envelope** — user values never share a namespace with
  bookkeeping (fixes defect 5):

  ```text
  { args: { <camelKey> → value },   # camelCase-only canonical keys (D5)
    err: bool, errmsg: []string, warnmsg: []string, defaulted: []string }
  ```

- Responsibilities: resolve schema via `ArgsSchema` (cached); map positional args
  via precomputed positions; normalize snake_case/kebab-case input keys for
  Bookshop; handle the `_default` pass-through key; walk each argument with the
  validator; enforce required arguments per `group`; assemble the envelope.
- `defaulted` lists dotted paths (`heading.align`) of every value that came from a
  default — superset of today's `default` slice.

### 3.4 Compatibility shims

- **`utilities/InitArgs.html`** becomes ~40 lines: call `Args.html` with
  `strict=false`; flatten `args` into the top-level map; add legacy key spellings
  (original kebab/snake keys alongside camelCase, exactly as today); merge
  `err`/`errmsg`/`warnmsg`/`default` keys. In non-strict mode the walker classifies
  *newly detectable* problems (falsy-value type mismatches, nested type mismatches,
  unknown nested keys) as warnings (D7); previously detected error classes remain
  errors. Net effect for all ~160 call sites: identical behavior except the
  nested-defaults bug fix and new warnings surfacing latent issues.
- **`utilities/InitTypes.html`** delegates to `ArgsSchema` and re-shapes its output
  to the legacy `{types, udt, err, errmsg, warnmsg}` form for the few direct
  callers. Marked deprecated in docs.

### 3.5 Error-handling philosophy (unchanged)

The system never calls `errorf` itself. It returns errors/warnings in the envelope
and callers decide via `LogErr.html` / `LogWarn.html`. This is what makes invalid
inputs testable with golden files.

## 4. Test harness (phase 0, before any behavior change)

- **Location:** `mod-utils/exampleSite`, replacing the stub.
- **Case definitions:** `exampleSite/data/tests/<group>.yml` — declarative cases:

  ```yaml
  cases:
    - name: nested-default-child        # BUG: currently returns parent default
      structure: test-heading
      args:
        title: Hello
  ```

  Groups: `defaults`, `casting`, `options`, `positional`, `required`, `nesting`,
  `bookshop`, `child`, `errors`, `warnings`, `envelope`.
- **Test structures:** dedicated fixtures under `exampleSite/data/structures/`
  (`test-*.yml` plus supporting `_types` entries) so tests do not depend on
  production structure files.
- **Rendering:** a test layout iterates every case, invokes the partial under test,
  and emits the full result envelope as canonical JSON (`jsonify` sorts map keys)
  to `public/tests/<group>/index.json` via a JSON output format.
- **Assertion:** `npm test` builds the exampleSite and diffs `public/tests/**`
  against committed `tests/golden/*.json`. Any drift fails CI (existing reusable
  test workflow, no new infrastructure).
- **Characterization-first:** the initial goldens pin *current* behavior, including
  bugs, each annotated `# BUG(<n>): …` referencing §1.1. Every later fix flips its
  golden in the same commit — behavior changes stay explicit and reviewable.
- Both `InitArgs.html` (shim path) and `Args.html` (strict path) are exercised: the
  same case files run through both entry points where applicable.

## 5. Phasing

| Phase | Deliverable | Risk gate |
| --- | --- | --- |
| 0 | Golden harness + characterization suite for current `InitArgs`/`InitTypes` | Goldens reviewed; CI green |
| 1 | `ArgsSchema.html` compiler (cached) + compile-error tests | Schema snapshots for representative structures match expectations |
| 2 | `inline/validate.html` + `utilities/Args.html` + strict-mode goldens | New-API suite green; old suite untouched |
| 3 | Rewire `InitArgs`/`InitTypes` as shims; flip goldens for intentional fixes (defects 1–6); warnings-first strictness | Hinode + mod-blocks exampleSites build without new errors; diff of emitted warnings reviewed |
| 4 | Caching enabled and measured (`hugo --templateMetrics` before/after on Hinode exampleSite) | No behavior drift in goldens; measurable build-time improvement |
| 5 (follow-up, separate effort) | Migrate Hinode v2 + first-party modules to `Args.html`; docs `args.md` consumes `ArgsSchema`; promote warnings to errors after one release cycle | Per-module PRs |

Phases 0–4 ship as mod-utils v5 minor releases (with clear release notes for the
new warnings). The phase-5 warning→error promotion is behaviorally breaking in the
strict semver sense, but a Go-module major bump would force a `/v6` import path —
the ecosystem-fork problem that ruled out scenario C. It therefore ships as a
well-communicated v5 minor after at least one full release cycle of warnings,
consistent with how mod-utils has rolled out stricter validation historically.

## 6. Risks and mitigations

- **Behavioral drift the goldens don't cover.** Mitigation: characterization suite
  is written *from the defect inventory and the full feature surface* (every branch
  of the current code gets at least one case) before refactoring starts; Hinode and
  mod-blocks exampleSites act as integration smoke tests in phase 3.
- **`partialCached` variant explosion.** Cache key is the `(structure, bookshop,
  child)` triple; the ecosystem has ~100s of structures, well within Hugo's cache
  comfort zone.
- **Hidden reliance on quirks** (e.g. sites depending on falsy values skipping
  validation). Mitigation: warnings-first rollout (D7) gives one release cycle of
  visibility before promotion.
- **Hugo version differences.** mod-utils supports the Hugo versions Hinode v2
  supports; the harness runs on the pinned CI Hugo version, and no new template
  functions beyond that baseline are introduced.
- **Private/derived themes** cannot be inventoried. Mitigation: no API or schema
  removal in v5; shims preserved indefinitely within v5.

## 7. Acceptance criteria

1. Golden suite covers every §1.1 defect plus the full documented feature surface
   (defaults, config lookups, casting, options, positional args, required/groups,
   deprecation, `_default`, Bookshop blueprint/sidecar, child structures,
   camelization, envelope shape).
2. Defects 1–6 are fixed on the strict path and warn on the shim path; each fix is
   visible as a golden diff in its own commit.
3. Recursive validation proven by cases nesting ≥3 levels (UDT → UDT → scalar) and
   lists of dicts, including defaults, options, and unknown-key detection at every
   level.
4. `ArgsSchema` results are cached; template metrics on the Hinode exampleSite show
   reduced cumulative time for argument initialization.
5. Hinode, mod-blocks, and mod-utils exampleSites build with zero new *errors*
   through the shim path.
6. No changes required to any YAML structure file, blueprint, or call site outside
   mod-utils.
