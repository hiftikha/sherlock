# Changelog

All notable changes to Sherlock are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- End-to-end interaction latency on the web: `sherlock_interact` (and `sherlock interact`) clicks a selector or point, or presses a key, in headless Chrome and breaks the interaction down from a DevTools trace into input delay, event handlers, script, network, style/layout/paint, idle and frame presentation, ending at the first displayed frame that shows the result (or at a `done_selector`). It also reports Event Timing (INP) numbers, the requests, the longest scripts, layout cost and, with `stacks`, hot JavaScript from the V8 sampler.
- A segmented bar per interaction on the dashboard's Interactions lane, an Interaction latency panel, and a terminal bar in the CLI.
- Findings: the slowest segment of each interaction (`Slowest segment of "open list" is network: 301 ms`), CPU busy time after a mark, and the hottest function during a marked interaction.
- Native interactions: a CPU and memory summary for every mark, and call stacks around a mark on macOS (`sherlock_mark` `stacks_seconds`, CLI `--mark-stacks`).
- `sherlock_web` `keep_open` keeps the page open for interactions; the browser closes when the session stops.

## [0.1.0] - 2026-10-16

The first pass.

### Added

- Native profiling on macOS and Linux: launch or attach, process-tree CPU, memory (physical footprint on macOS, RSS on Linux), threads, disk, network, whole-GPU utilization on macOS and memory bandwidth from `perf` on Linux, sampled every 100 ms.
- Startup phases: spawn, first output, a ready signal (log line, port or URL) and CPU settle.
- Startup call stacks on macOS from a separate warm-up launch with `sample -wait`, so the timed launch isn't slowed by the sampler. Rust v0, legacy Rust and C++ symbols are demangled.
- Web page startup in headless Chrome over the DevTools Protocol: TTFB, FCP, LCP, CLS, long tasks from a timeline trace, script, layout and style time, request weight, slowest requests and `.wasm` loads.
- iOS Simulator cold launch with `simctl`, and Android cold start with `am start -W` plus live `/proc` sampling over `adb`.
- Findings: wait-bound vs CPU-bound startup, hot function, main-thread-bound work, memory each repeated interaction keeps, steady memory growth, idle CPU, web vitals and mobile start thresholds.
- The live dashboard: one timeline with startup phases, interaction markers and resource lanes, NumberFlow numbers, a collapsible analyst rail, JSON and standalone HTML reports.
- A Claude Code plugin with the `/sherlock:profile` drill-pass skill and 13 MCP tools.
- A CLI and `npx` wizard, and a terminal agent on the Claude API.
