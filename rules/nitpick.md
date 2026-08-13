# Nitpick rules

- Names must match real responsibility, not just look fine in isolation.
- Judge names against nearby / related changed files and call sites in this PR.
- Flag names that understate or overstate what the code does.
- Prefer names a teammate would still trust after reading the whole PR.
- Avoid one-letter identifiers outside tiny loop indexes.
- Prefer small cohesive modules over grab-bag files.
- Delete dead code in the same PR when touched.
- When suggesting an extract/move, name the same destination path in howToFix, betterCode, and reviewComment.
