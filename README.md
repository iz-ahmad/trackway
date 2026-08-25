# Backstory

The history behind your code.

Backstory reads the session files your coding agent already writes to disk. It turns them into a searchable, version-controlled record of the questions you asked, the things you discovered, the decisions you made, and the options you rejected.

> **Status:** in development. Nothing here works yet. The design is settled and the implementation plan is written. See [Roadmap](#roadmap).

## The problem

You plan a feature with a coding agent. You weigh three approaches and pick one. Two weeks later you cannot remember why you rejected the other two.

The reasoning is not actually lost. It is sitting in a session file on your disk, along with hundreds of other session files, with no way to search them. Git tells you what the code became. It does not tell you what you considered and dropped, or what you learned along the way that made the decision obvious at the time.

Backstory makes that record searchable.

## How it works

Coding agents write every session to disk as they go. Backstory reads those files. It does not hook into your agent, sit between you and your model, or capture anything live.

```
agent session files          you keep working normally
        |
        v
    parse, strip model reasoning, redact credentials
        |
        v
    distill quiet sessions into records
        |
        v
    .backstory/  (git-tracked markdown)
        |
        +--> search        backstory search "why async"
        +--> explorer      backstory graph
        +--> your agent    via MCP
```

Distillation runs your own coding agent in headless mode. There is no second API key to configure and no separate provider to pay for.

A session is distilled once it stops changing. Closing a terminal, clearing a session, or crashing loses nothing, because the file was already written.

## Install

```bash
npm install -g backstory
cd your-project
backstory init
```

`init` writes the config, sets up ignore rules, and offers to install a hook so records accumulate while you work. The hook is installed once per machine and covers every repository, including ones you create later.

## Usage

Work with your coding agent normally. No commands during a session.

```bash
backstory search "why is cancellation async"   # search everything
backstory rejected --about caching             # options you dropped, and why
backstory decisions --actor human              # decisions you made, not the agent
backstory show dec-20260824-a3f2               # one record in full
backstory status                               # what is pending or failed
backstory graph                                # open the local explorer
```

`backstory graph` serves three views from your machine with no account and no network:

- **Timeline.** A session read top to bottom. The default view.
- **Decision map.** One decision with its rejected branches and the reason each was dropped.
- **Project history.** Every topic worked on, with counts.

## What gets stored

Records live in `.backstory/` as markdown, one file per record, tracked by git. You commit them alongside the code they explain.

| Type | What it holds |
| --- | --- |
| Question | Something asked during planning or investigation |
| Discovery | A fact learned about the system |
| Decision | A choice made, with rationale and rejected alternatives |
| Action | Implementation work that followed |
| Outcome | What happened afterwards |

Every record carries who decided. Backstory distinguishes an agent recommendation from your decision, from your override of the agent, and from an agent acting without your explicit approval. It will not claim you approved something you never saw.

A SQLite index sits next to the records for fast search. It is gitignored and rebuilt from the records on demand. The markdown files are the source of truth.

Records that turn out not to be worth keeping come out with `backstory forget`.

## Privacy

Everything runs on your machine. No account, no hosted backend, no telemetry, no external AI provider.

Two filters run before anything reaches disk:

- **Model reasoning is stripped.** Agent thinking blocks are dropped structurally, not heuristically.
- **Credentials are redacted.** Pattern matching over known key shapes plus a high-entropy check.

Credential redaction is best effort. A secret shaped like ordinary prose will get through. Review records before you commit them if the session touched sensitive material.

## Supported agents

| Agent | Read via | Ingest | Distill |
| --- | --- | --- | --- |
| Claude Code | session files | yes | yes |
| OpenCode | its own CLI, with built-in redaction | yes | yes |
| Codex | session files | yes | not yet |

Adding an agent means writing a parser behind one interface. Nothing in the core changes. Agents without a local session store can pipe a transcript into `backstory ingest`.

## For agents

Backstory ships a read-only MCP server so your coding agent can consult prior decisions before proposing changes. Results come back as dated evidence with attribution and source, not as commands. The agent decides what to do with them.

The server exposes no write tool. Records are created by distillation only.

## Roadmap

Version 1 covers ingestion, distillation, search, the explorer, and MCP retrieval across three agents.

Deliberately not in version 1:

- Alerts when a rejected option becomes viable again, for example a dependency you lacked at the time and now have
- Live agent hooks beyond a trigger
- A background daemon
- Semantic search
- Team trust controls
- Automatic linking of decisions to the commits that implemented them

## Contributing

Not yet accepting contributions. The core needs to work first.

## License

MIT
