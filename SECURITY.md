# Security

## What is in scope

Sherlock launches commands, reads process information, drives a headless browser and serves a local dashboard. A security problem is anything that lets a page, a prompt, a project file or another process make Sherlock run code, read files or reach the network in a way the user didn't ask for: in the MCP tools, the CLI, the terminal agent, the dashboard server, or the instructions in `skills/`.

Known boundaries:

- `sherlock_launch` and the agent's `run_command` run the command they are given. In Claude Code, Claude Code's permission prompts approve each tool call; the terminal agent asks before every command unless you pass `--yes`.
- The dashboard binds to `127.0.0.1` only and serves files from `ui/` only.
- The agent's `read_file` refuses paths outside the project root.

## Supported versions

Only the latest release and the latest commit on `main`.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's [private vulnerability reporting](https://github.com/hiftikha/sherlock/security/advisories/new). Include what you found, how to reproduce it and what it could let someone do.
