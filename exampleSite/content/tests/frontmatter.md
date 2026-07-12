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
