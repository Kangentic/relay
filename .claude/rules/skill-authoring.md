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
  `merge-pull-request`, `merge-back`, and `release` are gated, mutating workflows (commit,
  rebase, push, merge, tag, deploy) that need main-loop visibility and user confirmations -
  `release` most of all, since it is the only one that ships to real users; `code-review` and
  `test` are
  main-loop drivers that fan out read-only `Agent`-tool subagents and
  synthesize the results in the main loop, so forking the driver itself would risk nesting
  subagents (undocumented behavior); `sync-docs` stays inline for the same reason.
  `code-review` also commits its own pass, which is one more reason its driver stays in the
  main loop.
- **Never route a fixing or mutating skill to `agent: Explore` or `agent: Plan`** - those
  built-in agents are read-only and skip this repo's CLAUDE.md, so they would drop the
  conventions (single-command Bash, no em-dashes, no `any`, never link
  `@kangentic/protocol` at runtime). The default general-purpose fork loads CLAUDE.md and keeps
  the skill's `allowed-tools`.
- **A custom agent under `.claude/agents/` does not load CLAUDE.md either**, so any agent this
  repo defines must name the rule files it needs instead of assuming the conventions are in
  context. `code-review`'s finders spawn as `review-finder`
  (`.claude/agents/review-finder.md`) rather than `general-purpose`: the restricted roster
  (`Read, Glob, Grep`) drops the tool/MCP manifest from every finder's floor, and `model` plus
  `effort` pinned in its frontmatter keep a parallel fan-out from inheriting the Code Review
  column's `xhigh`. That agent therefore tells its finders to `Read` `.claude/rules/*.md`
  directly. Prefer a dedicated read-only agent over `general-purpose` for any future fan-out,
  and pin its effort there rather than per spawn.
- **Never fork a side-check while a gated skill is active.** A `subagent_type: "fork"` agent
  inherits the full conversation context, including a currently-running skill's instructions.
  Spawning one to "check on" a background task with an ambiguous prompt can cause it to pick up
  and independently execute the rest of that skill (e.g. a second commit/push/PR). To check on
  a background agent, wait for its natural completion notification instead of spawning another
  agent.

## Enforcement (self-maintaining)

- **Review:** judgment-based, applied when authoring or editing a skill or agent. No mechanical
  test - routing is a design decision, not a code shape.

## Scope

Skill authoring under `.claude/skills/` and agent definitions under `.claude/agents/`. Does not
govern product code.
