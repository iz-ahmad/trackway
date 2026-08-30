# Trackway

**Git tells you what your code became. Trackway tells you what it almost became, and why you decided against it.**

Trackway reads the session files your coding agent already writes to disk and turns them into a searchable, version-controlled record of the decisions behind your code, including the options you rejected and the reason each one was dropped.

> **Status:** v0.1.0. The full path runs end to end. Extraction quality is measured rather than guaranteed: see [How well does it work](#how-well-does-it-work).

## Why use this

You plan a feature with an agent. You weigh three approaches and pick one. The argument against the two you dropped gets written down at the moment you are deciding, while you genuinely do not know the answer yet. Then it evaporates.

Two weeks later you can ask Trackway *why didn't we use a background daemon?* and get the actual answer back:

> **Background daemon only** — rejected. *Fails silently in many ways (doesn't start, crashes, two copies), hard to debug when broken.*

Nothing else in your toolchain keeps that:

| Source | Records |
| --- | --- |
| Git history | what you built |
| PR descriptions | what you are shipping |
| ADRs | what you decided, written afterward and quietly rationalized |
| **Trackway** | **what you considered, and the case against each, written before the outcome was known** |

That last property is the one that is hard to fake. An architecture decision record written after the fact already knows how the story ended. These do not.

The second use is sharper than the first: **rejections expire.** "Conflicts with existing hooks, adds latency to commit" is only true while those conditions hold. When they change, that rejection is now wrong, and you can go find it.

### When not to use it

Be honest about the fit. Trackway is not worth the disk space if:

- The project is short-lived. You will remember.
- You already write ADRs seriously. Heavy overlap.
- You need a shared team decision log. This is single-developer and local. Records land in git, but there is no review gate, so a teammate has no particular reason to trust an automatically extracted record.

The honest fit is a developer working with an agent across months, on a codebase they will still be in next year, who has already had the experience of not remembering why something is the way it is.

## How it works

Coding agents write every session to disk as they go. Trackway reads those files. It does not hook into your agent, sit between you and your model, or capture anything live.

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
                    .trackway/records/*.md   ← git-tracked, in your diffs
                              |
                              v
              search · explorer · MCP retrieval
```

Two paths produce records, and they are not equally reliable. Trackway is explicit about which one a record came from.

**Harvested forks (deterministic).** When an agent presents you an explicit list of options, it stores the question, every option, and each option's rationale as structured tool input. Trackway reads that verbatim. No inference, no summarising, no model call. Measured across 485 real sessions, 186 forks were recorded this way, and every one is now classified:

| Outcome | Share | Recorded as |
| --- | --- | --- |
| You picked one of the options | 78% | a decision, with the rest as rejected options |
| You typed your own answer instead | 10% | a decision you authored, with **every** offered option rejected |
| You dismissed the question | 12% | an open question, because nothing was decided |

**Distillation (model-extracted).** Everything else goes through your own agent, running headless. This path is where the quality numbers below come from. It is a fallback, not the main event.

## Install

```bash
npm install -g trackway

cd ~/your-project
trackway init
```

Requires **Node 22 or newer** and a coding agent that stores sessions locally. `better-sqlite3` is a native module, so a first install compiles or downloads a prebuilt binary.

From source instead:

```bash
git clone https://github.com/me-shaon/trackway.git
cd trackway
npm install
npm run build
npm link            # puts `trackway` on your PATH
```

`init` writes the config, sets up ignore rules, and offers to install a hook so records accumulate while you work. The hook installs once per machine and covers every repository, including ones you create later.

## Usage

Work with your agent normally. There are no commands to run during a session.

```bash
trackway sync                                 # distil sessions that have gone quiet
trackway why src/limit.ts 42                  # what was decided that produced this line
trackway search "why is cancellation async"   # search everything
trackway rejected --about caching             # options you dropped, and why
trackway decisions --actor human              # decisions you made, not the agent
trackway show dec-20260824-a3f2               # one record in full
trackway status                               # what is pending or failed
trackway graph                                # open the local explorer
```

`trackway graph` serves three views from your machine, with no account and no network:

- **Story.** What happened on this project, grouped by topic, in the order it happened.
- **Decisions.** Every fork, ordered by how many options it recorded, each with the branches you did not take.
- **Overview.** What the record holds and which topics are worth opening.

All three share one rail of filters. Records are sorted into four kinds — *product*, *technical*, *your call*, and *working* — and only the first three are shown by default. On a real session that is 18 records out of 101.

Full reference:

| Command | Does |
| --- | --- |
| `trackway init` | set up the current repository |
| `trackway sync` | distil sessions that have gone quiet |
| `trackway ingest [file]` | read a transcript from any agent, from a file or stdin |
| `trackway why <file> [line]` | what was decided that produced this line, and what was rejected |
| `trackway status` | what is stored, which agents were found, what is pending |
| `trackway search <query>` | full-text search across every record |
| `trackway rejected [query]` | options considered and not taken |
| `trackway decisions` | decisions, newest first |
| `trackway show <id>` | one record in full |
| `trackway sessions` | sessions that produced records |
| `trackway forget <target>` | remove a record, or every record from a session |
| `trackway graph` | open the local explorer |
| `trackway mcp` | serve memory to a coding agent over stdio, read-only |
| `trackway eval` | measure extraction quality against the sessions' own answer key |
| `trackway rebuild` | rebuild the search index from the record files |

## What gets stored

Records are markdown with YAML front matter, one file per record, in `.trackway/records/`. They are meant to be committed. They show up in your diffs and your pull requests, which is the point: a decision that changed should be visible when it changes.

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

**Cursor has no adapter yet.** Its chat history lives in an undocumented SQLite database and no Cursor installation was available to verify a parser against. Guessing at a schema is how the Codex adapter shipped disabled for the wrong reason. Until then, `trackway ingest` takes it, and anything else.

Adding a first-class adapter means writing a parser behind one interface. Nothing in the core changes.

## Any other agent

Every adapter above reads a store somebody else designed, so support waits on reverse-engineering a format and on owning a machine with that agent installed. `trackway ingest` needs neither. Pipe it a transcript and it becomes records like any session found on disk: same distillation, same fork harvesting, same commit linking.

```bash
cat chat.json | trackway ingest
trackway ingest chat.json
```

```json
{
  "agent": "cursor",
  "sessionId": "composer-9f3a",
  "cwd": "/path/to/repo",
  "startedAt": "2026-08-27T10:00:00Z",
  "entries": [
    { "role": "user", "text": "We need rate limiting on the public API." },
    { "role": "assistant", "text": "Added middleware with a Redis token bucket." },
    { "role": "tool", "name": "Edit", "input": { "path": "src/limit.ts" }, "output": "ok" }
  ]
}
```

`agent` and `sessionId` are required; `sessionId` makes re-ingesting the same conversation a no-op rather than a duplicate. Every entry may carry its own `at`, and one without inherits the last seen. Credentials are redacted here exactly as they are on a session file.

### Getting the accurate path

Distillation is model-extracted, with recall 0.91 against the sessions' own answer key. Fork harvesting is deterministic and reads what the session recorded verbatim. Any transcript can use the second one.

Emit a tool entry named `AskUserQuestion`, `ask_question` or `request_user_input` whose input carries an option list, and the question, every option and each option's own reasoning are taken exactly as written, with no model involved:

```json
{
  "role": "tool",
  "name": "AskUserQuestion",
  "input": {
    "questions": [{
      "question": "Where should rate limiting live?",
      "options": [
        { "label": "At the edge, in the CDN", "description": "No app code, but no per-user quota." },
        { "label": "Middleware in the app", "description": "Per-user quota. Costs a Redis round trip." }
      ]
    }]
  },
  "output": "The user answered: \"Where should rate limiting live?\"=\"Middleware in the app\""
}
```

That produces a decision carrying the option taken and both rejected ones with their reasons. If the answer names none of the options, it is recorded as an answer the developer wrote themselves with every option rejected. If the question was dismissed, it is recorded as an open question rather than a decision nobody made.

## For agents

Trackway ships a read-only MCP server so your coding agent can consult prior decisions before proposing changes. Results come back as dated evidence with attribution and source, not as commands. The agent decides what to do with them.

The server exposes no write tool. Records are created by distillation only.

```json
{
  "mcpServers": {
    "trackway": { "command": "trackway", "args": ["mcp"] }
  }
}
```

## How well does it work

Two paths, two very different answers. Conflating them would flatter the tool.

**Harvested forks: deterministic.** Read verbatim from structured tool input. There is nothing to be accurate about; the data is the data. 186 forks across 485 sessions, all classified, none unresolved.

**Distillation: measured, on the one thing that can be measured cheaply.** Some sessions record an explicit option list and an answer to it. That is ground truth with no hand labelling, and across 485 sessions there are 165 such decision points.

**Recall against that key: 0.91**, over 6 sessions of 1 to 26 decision points. Of the decisions a session is known to have made, the extractor finds nine in ten. That number means what it says.

**There is no trustworthy precision figure here yet, and the one this file used to carry was wrong.** It reported 0.54, arrived at by counting every extracted decision the key did not contain as an error. But the key can only contain decisions made through an explicit option list, and most decisions are not made that way. They are made in conversation. Every correct extraction of one counted against the score, so the number fell as the extractor got better at its actual job.

Reading the worst-scoring session by hand settled it. All eight of its "false positives" were real engineering choices, five carrying recorded alternatives: cascade against null on delete, an observer against patching a controller, which approval flag to validate against. None was noise.

`trackway eval` now judges each extracted decision against the transcript it came from, as sound, distorted or invented, which is the question the key cannot ask. On one session it rates 9 of 9 sound where the key rated 3 of 9; against four planted records, three inventions and one real question with its answer inverted, it rates 0 of 4. A judge that cannot say no would measure nothing, so it was checked both ways before being believed.

A figure across every scored session is not published here yet. One session is an anecdote, and a run takes over an hour.

Read the rest carefully:

- **A seventh session was scored and is missing.** Its distillation timed out at five minutes. It is excluded rather than counted as a zero. Chunks are now retried, which is the fix for that class of failure.
- **Larger sessions are the weak spot.** The largest scored had 26 decision points at recall 1.00, but the next largest at 17 scored 0.71. Sessions far larger than that are unmeasured, because each costs around thirteen model calls.
- **Nobody but the author has run this.** Every figure on this page comes from one machine and one person's sessions.

Nothing gates a release on these numbers, by design. Suppressing a useful record to protect a score is the wrong trade.

Run it yourself:

```bash
trackway eval
```

## Release

One package. The workspace is six, and publishing all of them would mean an npm organisation, six releases kept in version lockstep, and a user installing a CLI that drags in five scoped packages. `npm run build:package` bundles the workspace code into a single binary and stages it in `packages/cli/npm/`.

Real dependencies stay external. `better-sqlite3` is native and cannot be bundled at all, and inlining the rest would trade a shared install for a bigger tarball. The build fails if two workspace packages declare different ranges for the same dependency, because the registry only sees one and the wrong one ships silently.

```bash
npm run build:package          # bundle, stage, and write the published manifest
npm run verify:package         # install the tarball clean and exercise it
npm run release                # all three in order, publishing last
```

Publish through `npm run release` rather than by hand. Publishing from `packages/cli/npm` directly runs no lifecycle script, so a stale bundle from an earlier build would ship without complaint.

Every workspace package stays `private: true`. The only manifest without that flag is the one the build generates, so nothing publishes by accident.

## Roadmap

Version 1 covers ingestion, distillation, commit linking, search, the explorer, and MCP retrieval across three agents, plus a transcript format for everything else.

Deliberately not in version 1:

- Alerts when a rejected option becomes viable again, for example a dependency you lacked at the time and now have
- A first-class Cursor adapter, until there is a machine to verify one against
- Live agent hooks beyond a trigger
- A background daemon
- Semantic search
- Team trust controls

## Development

```bash
npm install
npm run build      # compiles packages and builds the explorer
npm test           # 472 tests
npm run typecheck  # strict mode, sources and tests
```

The workspace is six packages. `core` holds the record model, the store, and search, and depends on nothing internal. `adapters` reads sessions. `distill` runs the sweep and the extractor. `server` serves the explorer API and MCP. `ui` is the explorer. `cli` wires them together.

## Contributing

Not yet accepting contributions. Recall needs to improve first.

## License

MIT for the code. See [LICENSE](LICENSE).

The explorer ships two typefaces, both under the SIL Open Font License 1.1, and both licences travel with them in `ui/fonts/` of the published package:

- **Commissioner**, copyright 2019 The Commissioner Project Authors. `OFL-Commissioner.txt`
- **IBM Plex Mono**, copyright 2017 IBM Corp. with Reserved Font Name "Plex". `OFL-IBM-Plex-Mono.txt`
