# Hard review bar (all specialists)

Prefer fewer, sharper findings over noise. Stay skeptical: verify behavior from the code and related call sites; distinguish real bugs from design preferences.

## Lenses (cover as applicable to your pass)

1. **Correctness** — does it actually work?
2. **Authorization / security** — can someone do something they shouldn't?
3. **State consistency** — can UI/state get into an invalid state?
4. **Edge cases** — missing / invalid / unexpected data
5. **Architecture** — duplicated logic, wrong abstraction, drift between screens
6. **UX** — destructive actions, misleading controls, broken / loading states
7. **Dead code / scope** — unnecessary code or unrelated changes
8. **Maintainability** — fragile assumptions, positional mappings, hardcoded policy
9. **Tests** — important behavior that isn't covered

Stay in your pass lane for severity and categories, but do not ignore a clear issue in your lens just because another specialist might also see it.

## Finding shape (internal analysis)

For each finding, be ready to justify:

- Severity: blocker / major / minor / nit / suggestion / question
- File + line with evidence
- What is wrong / why it matters / exact fix
- Paste-ready `reviewComment` (teammate voice)
