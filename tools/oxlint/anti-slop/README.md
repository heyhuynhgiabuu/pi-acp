# Vendored anti-slop rules

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

Upstream recommends vendoring rather than installing a package. This copy contains the generic rules only; the optional Effect rules are omitted because this project does not use Effect.

The root `.oxlintrc.json` enables all 18 generic rules at error severity. The current codebase has existing findings under this stricter policy; clearing them is intentionally deferred to the user's planned refactor rather than mixed into this tooling migration. The plugin implementation and rule sources are excluded from the app lint run so the rules do not lint their own implementation.

The upstream MIT license is in `LICENSE`. The separately vendored ESLint Stylistic implementation retains its license and source notes under `vendor/eslint-stylistic/`.

When updating, review and port changes from an explicit upstream commit, update this provenance, and keep `oxlint` and `@oxlint/plugins` on the same exact version.
