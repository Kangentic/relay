---
paths:
  - ".claude/skills/**"
---
# Rule: skill context (when to fork)

Claude Code's `context: fork` skill-frontmatter field runs a skill in an isolated subagent: no
prior conversation history, the SKILL.md as its prompt, and only a final summary back to the
main loop. Choosing it wrong makes a skill slow, lossy, or unsafe.

## The rule

- **Do NOT fork** any of this repo's current skills: `commit`, `pull-request`,
  `merge-pull-request`, and `merge-back` are gated, mutating workflows (commit, rebase, push,
  merge) that need main-loop visibility and user confirmations; `code-review` and `test` are
  main-loop drivers that fan out read-only `general-purpose` `Agent`-tool subagents and
  synthesize the results in the main loop, so forking the driver itself would risk nesting
  subagents (undocumented behavior); `sync-docs` stays inline for the same reason.
- **Never route a fixing or mutating skill to `agent: Explore` or `agent: Plan`** - those
  built-in agents are read-only and skip this repo's CLAUDE.md, so they would drop the
  conventions (single-command Bash, no em-dashes, no `any`, never link
  `@kangentic/protocol` at runtime). The default general-purpose fork loads CLAUDE.md and keeps
  the skill's `allowed-tools`.
- **Never fork a side-check while a gated skill is active.** A `subagent_type: "fork"` agent
  inherits the full conversation context, including a currently-running skill's instructions.
  Spawning one to "check on" a background task with an ambiguous prompt can cause it to pick up
  and independently execute the rest of that skill (e.g. a second commit/push/PR). To check on
  a background agent, wait for its natural completion notification instead of spawning another
  agent.

## Enforcement (self-maintaining)

- **Review:** judgment-based, applied when authoring or editing a skill. No mechanical test -
  skill routing is a design decision, not a code shape.

## Scope

Skill authoring under `.claude/skills/`. Does not govern product code.
