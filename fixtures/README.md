# Original end-to-end fixture

`consumer/source.ts` is data, not an executable example. `example-lib` is fictional; do not install it. The default tests and build exclude fixtures from execution/compilation.

After building SunsetGuard, run from the project root:

```sh
node dist/cli/bin.js analyze fixtures/consumer --package example-lib --symbol oldApi --format json
```

Expected: exit 0, one detected + complete-within-scope result, five findings: two value-reference, one type-reference, one import-only, and one direct-reexport. The shadowed parameter call is excluded. A real scan of this original fixture uses reportKind=scan; it is not a real downstream accuracy benchmark.

For file output, create an external report directory first and choose a new filename. Never write reports inside `fixtures/consumer`; existing files are not overwritten.
