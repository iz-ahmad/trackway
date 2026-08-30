# Trackway

**Git tells you what your code became. Trackway tells you what it almost became, and why you decided against it.**

Trackway reads the session files your coding agent already writes to disk and turns them into a searchable, version-controlled record of the decisions behind your code, including the options you rejected and the reason each one was dropped.

> **Status: v0.1.0.** The whole path works. Extraction is measured, not guaranteed: recall is good, and a meaningful share of extracted decisions are invented or wrong. See [How well does it work](#how-well-does-it-work) before trusting a record.

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

**Harvested forks (deterministic).** When an agent presents you an explicit list of options, it stores the question, every option, and each option's rationale as structured tool input. Trackway reads that verbatim: no inference, no summarising, no model call. Every fork ends one of three ways, and each is recorded as what it actually was:

| You | Recorded as |
| --- | --- |
| picked one of the options | a decision, with the rest as rejected options |
| typed your own answer instead | a decision you authored, with **every** offered option rejected |
| dismissed the question | an open question, because nothing was decided |

**Distillation (model-extracted).** Everything else goes through your own agent, running headless. This is the fallback, and where the quality numbers below come from.

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
trackway rejected --about caching             # options you dropped, and why
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

**Cursor has no adapter yet.** Its chat history is an undocumented SQLite database and there was no installation to verify a parser against. Guessing at a schema is how the Codex adapter shipped disabled for the wrong reason.

## Any other agent

Each adapter above reads a store somebody else designed, so a new one waits on reverse-engineering a format *and* on owning a machine with that agent installed. `trackway ingest` needs neither, and it is how Cursor works today. Pipe it a transcript and it becomes records like any session found on disk: same distillation, same fork harvesting, same commit linking.

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

`agent` and `sessionId` are required, and reusing a `sessionId` makes re-ingesting the same conversation a no-op rather than a duplicate. An entry without an `at` inherits the last one seen. Credentials are redacted here exactly as on a session file.

### Reaching the deterministic path

A transcript does not have to settle for model extraction. Name a tool entry `AskUserQuestion`, `ask_question` or `request_user_input`, give it an option list, and the question, every option and each option's reasoning are taken exactly as written, with no model involved:

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

That produces a decision carrying the option taken and both rejected ones with their reasons, on the same three-way rule as any other fork: an answer naming none of the options becomes a decision the developer authored, and a dismissed question stays a question.

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

Two paths, measured separately. Averaging them would flatter the tool.

**Fork harvesting is deterministic.** It reads what the session recorded, verbatim. There is nothing to be accurate about.

**Distillation is model-extracted and imperfect.**

**Recall is 0.93**, over 6 sessions of 1 to 26 decision points. Of the decisions a session is known to have made, nine in ten are found. It is scored against an answer key the sessions provide themselves: when a session records an option list and somebody answers it, that is ground truth with no hand labelling.

**Precision is roughly three in four, and that figure is not yet stable enough to pin down.** The key cannot measure it, because it only holds decisions made through an option list and most are made in conversation. So `trackway eval` judges each extracted record against the transcript it came from, as sound, distorted or invented. The judge was checked in both directions before being trusted: against four planted records, three inventions and one real question with its answer inverted, it scores zero.

Two measurements of precision have been published here and both were wrong, for different reasons, so this one is described rather than quoted until a run repeats itself. What is not in doubt: **some extracted decisions are invented**, meaning the session does not support them at all. Roughly one in four extracted decisions is either invented or states a real decision wrongly.

That is the honest weak spot and the reason this is 0.x. Records are markdown in your repository and appear in your diffs, so they are reviewable, but do not trust them blindly yet.

Two more limits worth knowing:

- **Large sessions are weaker.** A 26-point session scored recall 1.00; a 17-point one scored 0.71. Anything much larger is unmeasured, because each scored session costs around thirteen model calls and a run takes over an hour.
- **Nobody but the author has run this.** Every figure here comes from one machine and one person's sessions.

Nothing gates a release on these numbers. Suppressing a useful record to protect a score is the wrong trade.

```bash
trackway eval              # reproduce it
trackway eval --key-only   # skip the judging, and the model spend
```

## Releasing

```bash
npm run release    # build, verify against a clean install, then publish
```

One package reaches the registry; the workspace of six is bundled into it. Publish through the script rather than by hand: publishing from `packages/cli/npm` directly runs no lifecycle hook, so a stale bundle would ship without complaint. Every workspace package stays `private: true`, and the only manifest without that flag is the one the build generates.

## Roadmap

Today: ingestion, distillation, commit linking, search, the explorer, and MCP retrieval across three agents, plus a transcript format for everything else.

Before 1.0, in order: fewer invented records, then recall measured on long sessions, then somebody other than the author running it.

Deliberately out of scope for now:

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
npm test           # 505 tests
npm run typecheck  # strict mode, sources and tests
```

The workspace is six packages. `core` holds the record model, the store, and search, and depends on nothing internal. `adapters` reads sessions. `distill` runs the sweep and the extractor. `server` serves the explorer API and MCP. `ui` is the explorer. `cli` wires them together.

## Contributing

Not yet accepting contributions. Precision needs to improve first, and needs a measurement that repeats itself.

## License

MIT for the code. See [LICENSE](LICENSE).

The explorer ships two typefaces, both under the SIL Open Font License 1.1, and both licences travel with them in `ui/fonts/` of the published package:

- **Commissioner**, copyright 2019 The Commissioner Project Authors. `OFL-Commissioner.txt`
- **IBM Plex Mono**, copyright 2017 IBM Corp. with Reserved Font Name "Plex". `OFL-IBM-Plex-Mono.txt`
