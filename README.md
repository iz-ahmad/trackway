# Backstory

**Git tells you what your code became. Backstory tells you what it almost became, and why you decided against it.**

Backstory reads the session files your coding agent already writes to disk and turns them into a searchable, version-controlled record of the decisions behind your code, including the options you rejected and the reason each one was dropped.

> **Status:** working, not released. The full path runs end to end. See [How well does it work](#how-well-does-it-work) for measured quality and [Release](#release) for what is left before it can be installed from a registry.

## Why use this

You plan a feature with an agent. You weigh three approaches and pick one. The argument against the two you dropped gets written down at the moment you are deciding, while you genuinely do not know the answer yet. Then it evaporates.

Two weeks later you can ask Backstory *why didn't we use a background daemon?* and get the actual answer back:

> **Background daemon only** — rejected. *Fails silently in many ways (doesn't start, crashes, two copies), hard to debug when broken.*

Nothing else in your toolchain keeps that:

| Source | Records |
| --- | --- |
| Git history | what you built |
| PR descriptions | what you are shipping |
| ADRs | what you decided, written afterward and quietly rationalized |
| **Backstory** | **what you considered, and the case against each, written before the outcome was known** |

That last property is the one that is hard to fake. An architecture decision record written after the fact already knows how the story ended. These do not.

The second use is sharper than the first: **rejections expire.** "Conflicts with existing hooks, adds latency to commit" is only true while those conditions hold. When they change, that rejection is now wrong, and you can go find it.

### When not to use it

Be honest about the fit. Backstory is not worth the disk space if:

- The project is short-lived. You will remember.
- You already write ADRs seriously. Heavy overlap.
- You need a shared team decision log. This is single-developer and local. Records land in git, but there is no review gate, so a teammate has no particular reason to trust an automatically extracted record.

The honest fit is a developer working with an agent across months, on a codebase they will still be in next year, who has already had the experience of not remembering why something is the way it is.

## How it works

Coding agents write every session to disk as they go. Backstory reads those files. It does not hook into your agent, sit between you and your model, or capture anything live.

```
agent session files          you keep working normally
        |
        v
    parse, strip model reasoning, redact credentials
        |
        v
    harvest recorded forks  ──┐
    distil the rest          ─┤
                              v
                    .backstory/records/*.md   ← git-tracked, in your diffs
                              |
                              v
              search · explorer · MCP retrieval
```

Two paths produce records, and they are not equally reliable. Backstory is explicit about which one a record came from.

**Harvested forks (deterministic).** When an agent presents you an explicit list of options, it stores the question, every option, and each option's rationale as structured tool input. Backstory reads that verbatim. No inference, no summarising, no model call. Measured across 485 real sessions, 186 forks were recorded this way, and every one is now classified:

| Outcome | Share | Recorded as |
| --- | --- | --- |
| You picked one of the options | 78% | a decision, with the rest as rejected options |
| You typed your own answer instead | 10% | a decision you authored, with **every** offered option rejected |
| You dismissed the question | 12% | an open question, because nothing was decided |

**Distillation (model-extracted).** Everything else goes through your own agent, running headless. This path is where the quality numbers below come from. It is a fallback, not the main event.

## Install

Not yet on a registry. See [Release](#release).

```bash
git clone https://github.com/me-shaon/backstory.git
cd backstory
npm install
npm run build
npm link            # puts `backstory` on your PATH

cd ~/your-project
backstory init
```

Requires **Node 22 or newer** and a coding agent that stores sessions locally.

`init` writes the config, sets up ignore rules, and offers to install a hook so records accumulate while you work. The hook installs once per machine and covers every repository, including ones you create later.

## Usage

Work with your agent normally. There are no commands to run during a session.

```bash
backstory sync                                 # distil sessions that have gone quiet
backstory search "why is cancellation async"   # search everything
backstory rejected --about caching             # options you dropped, and why
backstory decisions --actor human              # decisions you made, not the agent
backstory show dec-20260824-a3f2               # one record in full
backstory status                               # what is pending or failed
backstory graph                                # open the local explorer
```

`backstory graph` serves three views from your machine, with no account and no network:

- **Story.** What happened on this project, grouped by topic, in the order it happened.
- **Decisions.** Every fork, ordered by how many options it recorded, each with the branches you did not take.
- **Overview.** What the record holds and which topics are worth opening.

All three share one rail of filters. Records are sorted into four kinds — *product*, *technical*, *your call*, and *working* — and only the first three are shown by default. On a real session that is 18 records out of 101.

Full reference:

| Command | Does |
| --- | --- |
| `backstory init` | set up the current repository |
| `backstory sync` | distil sessions that have gone quiet |
| `backstory status` | what is stored, which agents were found, what is pending |
| `backstory search <query>` | full-text search across every record |
| `backstory rejected [query]` | options considered and not taken |
| `backstory decisions` | decisions, newest first |
| `backstory show <id>` | one record in full |
| `backstory sessions` | sessions that produced records |
| `backstory forget <target>` | remove a record, or every record from a session |
| `backstory graph` | open the local explorer |
| `backstory mcp` | serve memory to a coding agent over stdio, read-only |
| `backstory eval` | measure extraction quality against the sessions' own answer key |
| `backstory rebuild` | rebuild the search index from the record files |

## What gets stored

Records are markdown with YAML front matter, one file per record, in `.backstory/records/`. They are meant to be committed. They show up in your diffs and your pull requests, which is the point: a decision that changed should be visible when it changes.

Five record types: **question**, **discovery**, **decision**, **action**, **outcome**.

Every record carries who decided. The four states are kept apart rather than collapsed, because the difference between *you approved this* and *the agent proceeded* is the whole reason to record attribution at all:

- `you decided`
- `agent proposed, you accepted`
- `agent decided, no approval`
- `you asked` / `agent asked` for questions

Record IDs are derived from content, not from a counter. Two branches cannot mint the same ID for different records, and re-ingesting a session is a no-op.

## Privacy

Everything runs on your machine. No account, no hosted backend, no telemetry, no external AI provider. The explorer serves from localhost and loads no fonts, scripts, or stylesheets from any other host.

Two filters run before anything reaches disk:

- **Model reasoning is stripped.** Agent thinking blocks are dropped structurally, not heuristically.
- **Credentials are redacted.** Pattern matching over known key shapes plus a high-entropy check.

Credential redaction is best effort. A secret shaped like ordinary prose will get through. Review records before you commit them if the session touched sensitive material.

## Supported agents

| Agent | Read via | Ingest | Distil |
| --- | --- | --- | --- |
| Claude Code | session files in `~/.claude/projects/` | yes | yes |
| Codex | rollout files in `~/.codex/sessions/` | yes | yes |
| OpenCode | its local SQLite database, read-only | yes | yes |

OpenCode was meant to go through `opencode export --sanitize`, which returns already-redacted JSON. That path does not work non-interactively: `opencode session list` writes nothing when stdout is not a terminal, so sessions cannot be enumerated. Reading the database directly needs no binary and no terminal.

**Cursor is not supported yet.** Its chat history lives in an undocumented SQLite database, and no Cursor installation was available to verify a parser against. Guessing at a schema is how the Codex adapter shipped disabled for the wrong reason, so it waits for a machine that can test it.

Adding an agent means writing a parser behind one interface. Nothing in the core changes.

## For agents

Backstory ships a read-only MCP server so your coding agent can consult prior decisions before proposing changes. Results come back as dated evidence with attribution and source, not as commands. The agent decides what to do with them.

The server exposes no write tool. Records are created by distillation only.

```json
{
  "mcpServers": {
    "backstory": { "command": "backstory", "args": ["mcp"] }
  }
}
```

## How well does it work

Two paths, two very different answers. Conflating them would flatter the tool.

**Harvested forks: deterministic.** Read verbatim from structured tool input. There is nothing to be accurate about; the data is the data. 186 forks across 485 sessions, all classified, none unresolved.

**Distillation: measured.** Quality is checked against an answer key the sessions provide themselves. When an agent records an explicit option list, that list is ground truth with no hand labelling. 44 of 110 sessions carry one, giving 178 known decision points.

Measured across 7 sessions of 15 to 260 events: **precision 0.57, recall 0.68, F1 0.62**.

Read that scope carefully:

- **Recall on large sessions is unmeasured.** An earlier run scored recall 0.06 and 0.11 on sessions of 17 and 27 decision points, because the extractor capped each session at 200 events and silently ignored the rest. Chunking fixed the cap and full coverage is verified directly, but the recall it produces on a long session has not been measured, because those sessions cost 13 model calls each.
- **Precision near 0.57** means roughly two in five extracted records are not in the answer key. Some are real extractions the key does not contain, since the key only covers decisions recorded as an explicit option list. Others are noise. The four-kind filter hides most of it, but that is concealment, not accuracy.

Nothing gates a release on these numbers, by design. Suppressing a useful record to protect a score is the wrong trade.

Run it yourself:

```bash
backstory eval
```

## Release

Not published. Three things stand in the way, and one of them is a name.

1. **The npm name `backstory` is taken.** It belongs to an unrelated tool that attaches AI prompts to git commits as git notes. A scoped name such as `@me-shaon/backstory` is free and keeps the word.
2. **Every workspace package is `private: true`** at version `0.0.0`. The CLI depends on five of them, so publishing the CLI alone would install a broken package. Either publish all six under a scope, or bundle the workspace dependencies into the CLI so one package ships.
3. **No `files` field** in any package, so a publish would ship sources, tests, and fixtures.

Until then, install from source as shown above.

## Roadmap

Version 1 covers ingestion, distillation, search, the explorer, and MCP retrieval across three agents.

Deliberately not in version 1:

- Alerts when a rejected option becomes viable again, for example a dependency you lacked at the time and now have
- Live agent hooks beyond a trigger
- A background daemon
- Semantic search
- Team trust controls
- Automatic linking of decisions to the commits that implemented them

## Development

```bash
npm install
npm run build      # compiles packages and builds the explorer
npm test           # 428 tests
npm run typecheck  # strict mode, sources and tests
```

The workspace is six packages. `core` holds the record model, the store, and search, and depends on nothing internal. `adapters` reads sessions. `distill` runs the sweep and the extractor. `server` serves the explorer API and MCP. `ui` is the explorer. `cli` wires them together.

## Contributing

Not yet accepting contributions. Recall needs to improve first.

## License

MIT
