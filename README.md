# Pi Swarm

A personal [Tintin Pi Subagents](https://github.com/tintinweb/pi-subagents) workflow for large batch inspection, classification, review, and bounded edits.

```text
Pilot 1 → discuss criteria and sample with user → explicit approval
        → qualify 3 → waves of up to 6 until the batch finishes
```

Shared reads may overlap. Write targets must be disjoint. Ordinary notes and verified no-change results pass; unresolved criteria return questions. Failed shards retain their evidence and any reported partial edits.

## Setup

Requires Pi and `@tintinweb/pi-subagents` (tested with 0.19.0), with `Explore` and `Operator` roles. Recommended tools: Explore `read, grep, find, ls`; Operator adds `edit, write`. Disable extensions/skills in those roles and permit applying user-confirmed criteria.

The workflow pins two existing local provider aliases at `low` effort:

- `litellm-local/or-deepseek-v4-flash-latest`
- `litellm-local/deepseek-bot-v4-flash`

These aliases are personal configuration, not universal provider IDs. Configure equivalent models or edit the constants before use. No credentials are included.

Clone this repository, start Pi in your target project, and ask:

> Run the Swarm workflow using the absolute scriptPath of this checkout's workflows/swarm.js. Prepare one representative pilot, ask me about missing criteria, and show me the sample and complete execution scope before expanding.

Pi should invoke `SubagentWorkflow` with that absolute `scriptPath`. Named discovery in Tintin 0.19.0 skips symlinked workflow files. `args.cwd` documents the project but does not change the actual Pi working directory.

## Usage

The main Pi agent prepares the arguments; you normally only discuss the task and approve its sample. The implementation's opening comments describe the interface.

Minimal inspection arguments:

```json
{
  "mode": "inspect",
  "cwd": "/project",
  "objective": "Classify job records using resume evidence",
  "rule": "Missing evidence means unknown, not absence of skill.",
  "sharedReadPaths": ["/project/profile.md", "/project/rubric.md"],
  "shards": [{
    "id": "sample",
    "paths": ["/project/jobs.csv"],
    "instruction": "Process job IDs 1–10 only.",
    "expected": ["Return a conclusion and evidence for each assigned record."]
  }]
}
```

1. Start with one pilot and draft criteria. The main agent relays `questionsForUser`; ordinary observations stay in `notes`.
2. Once the sample succeeds, retain `pilotRecord`. Add the remaining shards and resubmit it to prepare the full approval contract without repeating the sample.
3. Show the sample, checks, partial changes, and full batch to the user. Only after approval, pass just `{ pilotRecord, pilotApproval }` with `pilotApproval.approvedByUser: true`. The workflow restores the full arguments from `pilotApproval.contract`; do not reconstruct either record or use the pilot-only contract as the batch.
4. Three qualification shards run before six-agent waves. A full wave uses four OpenRouter DSF and two official DeepSeek DSF agents. Thirty shards continue as 1 + 3 + 6 + 6 + 6 + 6 + 2.

Rollout needs at least four total shards and a shared rule. Edit shards additionally need exact `allowedFiles`, `preconditions`, and `forbiddenActions`. Pilot edits are real; inspect the diff before approving more. Keep shared inputs stable during concurrent work. Record groups or review concerns belong in shard instructions; no mandatory work-item registry is used.

Approval records are caller-supplied coordination state, not authenticated proof of a human decision. Read/write scope checks inspect reported results; they are not an OS filesystem sandbox. The main Pi must faithfully obtain approval and independently check changes.

## Main-agent communication

If the user only says “use Swarm”, explain: clarify → pilot → user approval → batch execution. Reuse known context and ask only for missing inputs, desired output, acceptance criteria, and edit permission. Propose criteria when needed; never silently decide them. Before an edit pilot, establish exact writable files and prohibitions; otherwise inspect first. Show the sample and full scope for explicit approval. Retrieve original continuation records rather than inventing them. Report submitted, running, and completed only as supported by observed state.

## Recovery

Inspect `failed`, `completed`, and `reportedChangedFiles` before retrying. Partial edits are preserved, not automatically reverted. A failure stops new waves after the current wave settles.

Tintin's `resumeFromRunId` can replay unchanged execution prefixes within the same Pi session. It is not arbitrary per-shard caching and does not detect changes to input files. Structured blocked results may also be cached. Review actual inputs and prior writes before resuming; update affected task criteria when resolving a blocked result. Reuse a preparation sample through `pilotRecord`; use an execution run ID when resuming execution.

## Tests

```bash
node --test tests/swarm.test.mjs
```

Tests use the installed Tintin runtime with a fake model host: no model requests or project writes. Set `PI_SUBAGENTS_DIR` if Tintin is not installed under `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents`.
