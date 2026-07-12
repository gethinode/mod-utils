# Hinode Module - Utilities

<!-- Tagline -->
<p align="center">
    <b>A Hugo module with common utilities for your Hinode site</b>
    <br />
</p>

<!-- Badges -->
<p align="center">
    <a href="https://gohugo.io" alt="Hugo website">
        <img src="https://img.shields.io/badge/generator-hugo-brightgreen">
    </a>
    <a href="https://gethinode.com" alt="Hinode theme">
        <img src="https://img.shields.io/badge/theme-hinode-blue">
    </a>
    <a href="https://github.com/gethinode/mod-utils/commits/main" alt="Last commit">
        <img src="https://img.shields.io/github/last-commit/gethinode/mod-utils.svg">
    </a>
    <a href="https://github.com/gethinode/hinode/issues" alt="Issues">
        <img src="https://img.shields.io/github/issues/gethinode/hinode.svg">
    </a>
    <a href="https://github.com/gethinode/mod-utils/pulls" alt="Pulls">
        <img src="https://img.shields.io/github/issues-pr-raw/gethinode/mod-utils.svg">
    </a>
    <a href="https://github.com/gethinode/mod-utils/blob/main/LICENSE" alt="License">
        <img src="https://img.shields.io/github/license/gethinode/mod-utils">
    </a>
</p>

## About

![Logo](https://raw.githubusercontent.com/gethinode/hinode/main/static/img/logo.png)

Hinode is a clean blog theme for [Hugo][hugo], an open-source static site generator. Hinode is available as a [template][repository_template], and a [main theme][repository]. This repository maintains a Hugo module that define common utilities compatible with your Hinode site. Visit the Hinode documentation site for [installation instructions][hinode_docs].

## Configuration

This module supports the following parameters (see the section `params.modules` in `config.toml`):

| Setting                 | Default | Description |
|-------------------------|---------|-------------|
| utils.filter      | `[^0-9A-Za-zŽžÀ-ÿ ;.,\/'’"]` | Defines the regular expression for characters to remove from page descriptions. These page descriptions are used to define card content and metadata for search indexes. Adjust the filter to define which characters to support. You may need to adjust these settings to support specific diacritical letters. |
| utils.raw         | false | Flag to indicate page descriptions should be returned as-is. In this setting, the filter is ignored. |

## Argument validation

This module provides the argument and type validation system used by shortcodes, partials, and
Bookshop components across the Hinode ecosystem. As of v5 the system is split into a cached
schema compiler (`ArgsSchema.html`), a strict recursive validator (`Args.html`), and two
compatibility shims (`InitArgs.html`, `InitTypes.html`) that preserve the legacy contract for
existing call sites.

### `Args.html` — clean entry point

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

Returns a separated envelope — user values never share a namespace with bookkeeping keys:

```text
{ args: { <camelKey> → value },   # camelCase-only canonical keys
  err: bool, errmsg: []string, warnmsg: []string, defaulted: []string }
```

`defaulted` lists the dotted path (e.g. `heading.align`) of every value that was filled from a
default, at any nesting depth.

The legacy `bookshop-` prefix sugar (passing `structure: "bookshop-hero"` to redirect to the
`hero` Bookshop component) is **not** part of the clean API — it is preserved only inside the
`InitArgs.html` shim for backward compatibility. Callers using `Args.html` directly must pass
`bookshop` explicitly.

### `ArgsSchema.html` — cached schema compiler

`Args.html` resolves its schema through `ArgsSchema.html`, invoked (and cached) per
`(structure, bookshop, child)` triple:

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
      "default", "config", "options", "position", "group" ([]string),
      "deprecated", "alternative", "release", "parent", "comment"   — present only when defined
      "optional"   bool     always present on every node
      "reflects"   []string optional; raw package-qualified Go reflect-type names (e.g.
                   "template.HTML") declared in the data files, matched verbatim against
                   printf "%T" of the value at validation time
```

Callers MUST invoke it through
`partialCached "utilities/ArgsSchema.html" (dict …) (or $structure "") (or $bookshop "") (or $child "")`
to benefit from caching; a plain `partial` call still works but recompiles the schema on every
call.

### Migration note

`InitArgs.html` and `InitTypes.html` remain supported as compatibility shims within v5. They
preserve the legacy flat-map return shape (argument values under their declared names plus
camelCase duplicates, merged with `err`/`errmsg`/`warnmsg`/`default`) and run `Args.html` in
non-strict mode. New code should call `Args.html` (and `ArgsSchema.html`, where the raw compiled
schema is needed) directly. There is no plan to remove the shims within v5; migrating existing
call sites across Hinode, mod-blocks, and other modules to the clean API is a separate, deferred
effort.

### Null-tolerance rule

At every nesting level, `null`/absent is treated as "not provided": it is eligible for
defaulting (an `isset`-based `config` site-parameter lookup first — honoring an explicit `false`
or `0` site value — then the static `default`) and exempt from type, option, and range errors.
This is distinct from a value the caller *explicitly* provided as `false`, `0`, or `""`, which
**is** validated against the declared type. This is what lets a CloudCannon-authored payload
(every blueprint key present, typically `null`, plus `_bookshop_name`/`_ordinal`) build clean
while a genuinely wrong explicit value is still caught.

### Warnings-first strictness rollout

The following newly detectable problem classes surface as **warnings** (`warnmsg`, `err: false`)
through the `InitArgs.html`/`InitTypes.html` shims, rather than errors, for one full v5 release
cycle:

- Falsy-value type/select mismatches at the top level (e.g. `0` failing an `int` check, `false`
  failing a `select` check).
- Nested member type/select/range findings (anything below the top level).
- Unknown nested attributes.
- Excess positional arguments.

Calling `Args.html` directly with `strict: true` (the default) already treats every one of these
as an error today. After one release cycle of the shim surfacing them as warnings, they will be
promoted to errors in `InitArgs.html`/`InitTypes.html` too. Watch your own build's `warnmsg`
output (or switch early to `Args.html`) to find call sites that need fixing before that
promotion release.

## Contributing

This module uses [semantic-release][semantic-release] to automate the release of new versions. The package uses `husky` and `commitlint` to ensure commit messages adhere to the [Conventional Commits][conventionalcommits] specification. You can run `npx git-cz` from the terminal to help prepare the commit message.

<!-- MARKDOWN LINKS -->
[hugo]: https://gohugo.io
[hinode_docs]: https://gethinode.com
[repository]: https://github.com/gethinode/hinode.git
[repository_template]: https://github.com/gethinode/template.git
[conventionalcommits]: https://www.conventionalcommits.org
[husky]: https://typicode.github.io/husky/
[semantic-release]: https://semantic-release.gitbook.io/
