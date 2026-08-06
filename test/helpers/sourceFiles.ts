import { readdirSync } from 'node:fs';
import path from 'node:path';

export const SRC_ROOT = path.join(import.meta.dirname, '..', '..', 'src');

/**
 * Every .ts file under `root` as a POSIX-style path relative to it,
 * discovered by walking the tree rather than from a list maintained by
 * hand. A hand-kept list could only catch a violation in a file somebody
 * remembered to add to it, which is the opposite of how a tree-wide
 * invariant check earns its keep: the file most likely to violate one is a
 * brand-new one, and it is just as likely to land in a subdirectory as at
 * the top level, so the walk recurses.
 */
export function everyTypeScriptFile(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith('.ts')) {
        found.push(path.relative(root, fullPath).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found;
}

/** Every .ts file under src/, as a POSIX-style path relative to src/. */
export function everySourceFile(): string[] {
  return everyTypeScriptFile(SRC_ROOT);
}
