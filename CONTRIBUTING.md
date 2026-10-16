# Contributing to Sherlock

Thanks for helping. Issues and pull requests are welcome.

## Set up

```sh
git clone https://github.com/hiftikha/sherlock.git && cd sherlock
npm install
npm test
```

You need Node 22 or later. The Rust test needs `cargo`, the web test needs Chrome or Chromium (set `CHROME_PATH` if it isn't found), and the real iOS test runs only when a Simulator is booted. Each skips with a reason when its tool is missing.

## House rules

- **No runtime dependencies for profiling.** Everything under `src/` except `agent.mjs` uses Node's built-in modules only, so the Claude Code plugin runs with no install step. Keep it that way.
- **Never report a guess as a measurement.** If a platform can't measure something, set the capability to `null` with a reason; the dashboard and the agent both show it as unavailable.
- **Parsers are pure.** Each tool's output is parsed by a function in `src/parse/` with a unit test against real output saved in `test/fixtures/`. When you add a platform, add the parser, a fixture and a test first.
- **Don't perturb what you measure.** Anything that attaches to the process during a timed launch must happen in a separate pass.
- **Readable source only.** The plugin directory is scanned, so commit plain, unminified JavaScript.

## Adding a platform

1. Write the parsers in `src/parse/` and their unit tests in `test/unit/`.
2. Write a sampler with the `sample(t)` / `stop()` / `capabilities` shape used in `src/platform/host.mjs`.
3. Add a profile function that creates a `Session`, sets `startup` and `phases`, and starts sampling.
4. Expose it as a tool in `src/tools.mjs` and a command in `cli/sherlock.mjs`.
5. Add an integration test, with a recorded stand-in for the platform's CLI when CI can't run the real thing (see `test/fixtures/bin/`).

## Releases

Bump `version` in both `package.json` and `.claude-plugin/plugin.json` (a test checks they match), add a `CHANGELOG.md` entry, and tag `vX.Y.Z`.
