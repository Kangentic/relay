#!/usr/bin/env node
// Prints the CHANGELOG.md section matching a version tag, so
// .github/workflows/release.yml's gh-release job fails loudly instead of
// publishing a release with an empty or generic body when someone forgets
// to update the changelog before tagging.
//
// Usage: node scripts/release/extract-changelog.mjs v0.1.0

import { readFileSync } from 'node:fs';
import process from 'node:process';

const tag = process.argv[2];
if (!tag) {
  console.error('usage: extract-changelog.mjs <tag>');
  process.exit(1);
}
const version = tag.replace(/^v/, '');

const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.split('\n');

const headingPattern = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`);
const startIndex = lines.findIndex((line) => headingPattern.test(line));
if (startIndex === -1) {
  console.error(`no CHANGELOG.md section found for ${version}. Promote [Unreleased] to [${version}] before tagging.`);
  process.exit(1);
}

const rest = lines.slice(startIndex + 1);
const endOffset = rest.findIndex((line) => /^## \[/.test(line));
const section = endOffset === -1 ? rest : rest.slice(0, endOffset);

const body = section.join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md section for ${version} is empty`);
  process.exit(1);
}

console.log(body);
