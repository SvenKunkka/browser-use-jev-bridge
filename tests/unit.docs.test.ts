/**
 * Documentation regressions.
 *
 * Three claims in the shipped docs were unsafe, and a fourth is now out of
 * date. They are cheap to reintroduce by accident while editing prose, so they
 * are asserted here rather than left to review:
 *
 *   - "the page is left as it was" and "nothing was dispatched" — true only of
 *     the *declined action*, never of the run;
 *   - "safe to re-run" — a re-run can repeat an action that already landed;
 *   - "MCP is not implemented" — it is, and it is covered by protocol tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCS = ['README.md', 'docs/ARCHITECTURE.md', 'docs/SECURITY.md', 'skill/SKILL.md'];

function read(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /page is left as it was/i, why: 'earlier steps in the same run may already have changed the page' },
  {
    // The unsafe form is the unconditional one. "only an empty history shows
    // that nothing was dispatched" is the correct, scoped statement.
    pattern: /stopped_by_approval[^.\n]{0,40}nothing was dispatched/i,
    why: 'only the declined action is known not to have been dispatched',
  },
  {
    pattern: /nothing (?:at all )?(?:was|reached the browser)[^.\n]{0,20}(?:so|therefore)[^.\n]{0,30}safe/i,
    why: 'a stopped run is not automatically safe to repeat',
  },
  { pattern: /safe to re-?run/i, why: 'a re-run can repeat an action that may already have taken effect' },
  { pattern: /MCP is not implemented/i, why: 'the MCP server ships and is covered by protocol tests' },
  { pattern: /no MCP server in this version/i, why: 'the MCP server ships' },
];

const REQUIRED: { file: string; pattern: RegExp; why: string }[] = [
  {
    file: 'docs/SECURITY.md',
    pattern: /only the declined action/i,
    why: 'SECURITY must scope the "not executed" guarantee to the declined action',
  },
  {
    file: 'docs/SECURITY.md',
    pattern: /effect_uncertain/,
    why: 'SECURITY must document the uncertain-effect state',
  },
  {
    file: 'skill/SKILL.md',
    pattern: /before re-?running/i,
    why: 'the skill must tell an agent to inspect before re-running',
  },
  { file: 'README.md', pattern: /bu-fast-mcp/, why: 'README must document the MCP entry point' },
  { file: 'skill/SKILL.md', pattern: /browser_fast_start/, why: 'the skill must prefer the MCP tools' },
];

test('regression — no document claims a stopped run left the page untouched', () => {
  for (const file of DOCS) {
    const text = read(file);
    for (const { pattern, why } of BANNED) {
      const match = pattern.exec(text);
      assert.equal(match, null, `${file} contains a banned claim (${why}): ${match?.[0] ?? ''}`);
    }
  }
});

test('regression — the documents state the correct recovery semantics', () => {
  for (const { file, pattern, why } of REQUIRED) {
    assert.match(read(file), pattern, `${file}: ${why}`);
  }
});

test('every document mentions that Pi internal actions are not enumerated', () => {
  for (const file of ['README.md', 'docs/ARCHITECTURE.md', 'docs/SECURITY.md', 'skill/SKILL.md']) {
    assert.match(
      read(file),
      /not enumerated|are not enumerable|does not enumerate/i,
      `${file} must be explicit that Pi's internal browser actions are not enumerated`,
    );
  }
});
