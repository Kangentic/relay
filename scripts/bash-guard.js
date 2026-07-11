#!/usr/bin/env node
/**
 * PreToolUse hook -- blocks chained/piped Bash commands.
 *
 * Reads hook context JSON from stdin. If the tool is Bash and the command
 * contains forbidden shell operators outside of quoted strings, emits a
 * deny decision to stdout. Otherwise exits silently (implicit allow).
 */

const FORBIDDEN = ['&&', '||', ' | ', '; ', '2>/dev/null', '2>&1'];

/**
 * Walk `str` char-by-char, tracking single/double quote state.
 * Returns the first pattern from `patterns` found outside quotes, or null.
 */
function findOutsideQuotes(str, patterns) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) continue;

    for (const pat of patterns) {
      if (str.startsWith(pat, i)) {
        return pat;
      }
    }
  }
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return; // malformed JSON -- allow
  }

  if (data.tool_name !== 'Bash') return;

  const command = data.tool_input && data.tool_input.command;
  if (typeof command !== 'string') return;

  const found = findOutsideQuotes(command, FORBIDDEN);
  if (!found) return;

  const label = found.trim() || found;
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Single-command Bash calls only. Found: ${label}. ` +
        'Use separate Bash calls or dedicated tools (Read, Grep, Glob).',
    },
  };
  process.stdout.write(JSON.stringify(output));
});
