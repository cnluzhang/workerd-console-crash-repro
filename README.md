# workerd console crash repro

Minimal repro for a process-level crash in `workerd serve` introduced by
cloudflare/workerd [#6874](https://github.com/cloudflare/workerd/pull/6874)
("Refactor console method decoration for snapshotting"), first released in
`1.20260929.1`.

The worker calls `console.log()` with a value whose formatting throws a
null-prototype object, inside a `try/catch`:

```js
console.log({ get [Symbol.toStringTag]() { throw Object.create(null); } });
```

Expected behavior is that the worker keeps running and returns `survived`, as
it does on `1.20260928.1`. On `1.20260929.1` the whole `workerd` process
aborts; the worker's `try/catch` cannot intercept it, and every other service
in the same process goes down with it. The config includes an unrelated,
statically configured `bystander` worker on its own socket to show this: it
serves requests before the `console.log()` call and refuses connections after.

The test runs a 2-version matrix with the default `workerd serve` console mode
and no compatibility flags:

- `1.20260928.1` (last good)
- `1.20260929.1` (first bad, current release)

Observed behavior:

```text
- workerd@1.20260928.1: PASS
    bystander before: HTTP 200 "bystander ok"
    console worker:   HTTP 200 "survived"
    bystander after:  HTTP 200 "bystander ok"
    process:          still running
- workerd@1.20260929.1: FAIL
    bystander before: HTTP 200 "bystander ok"
    console worker:   request failed (ECONNRESET)
    bystander after:  request failed (ECONNREFUSED)
    process:          exited with code 1
    log:              *** Fatal uncaught std::exception: Uncaught JsExceptionThrown
```

Root cause (confirmed by code inspection):

1. `formatLog()` in `src/node/internal/internal_inspect.ts` catches formatting
   errors, but its fallback formats the caught value again with
   `isError(err) ? err.stack : String(err)`. `String()` of a null-prototype
   object throws, so the exception escapes `formatLog()`. `handleLog()` in
   `src/workerd/io/worker.c++` calls it through `jsg::check(...)`, which turns
   the pending JS exception into a C++ `jsg::JsExceptionThrown`.
2. Before #6874, each console method was installed with
   `jsg::Lock::wrapSimpleFunction()`, whose `liftKj()` boundary catches
   `JsExceptionThrown`. The JS exception had already been absorbed by
   `handleLog()`'s `v8::TryCatch`, so the log line was dropped silently.
   #6874 installs `consoleDecorator` directly with `v8::Function::New()`, with
   no C++ exception boundary, so `JsExceptionThrown` unwinds through V8 frames
   to the top of the process.

The body of `handleLog()` is otherwise unchanged between the two releases.
Other values that make the fallback throw behave the same way, for example a
`nodejs.util.inspect.custom` method that throws `Object.create(null)`, or one
that throws an `Error` whose `stack` getter throws. `console.error()` crashes
the same way.

Run:

```bash
npm install
npm test
```

The non-zero exit code on the affected version is intentional: this is a
failing regression test. Use the per-version lines to compare the cases.

The `workerd` npm packages download their platform binary during `postinstall`.
If your npm setup blocks install scripts, approve the `workerd` scripts or set
`WORKERD_20260928_BIN` / `WORKERD_20260929_BIN` to existing binaries before
running the test.
