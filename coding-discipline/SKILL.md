---
name: coding-discipline
description: ALWAYS load this skill FIRST, without exception, BEFORE writing or modifying ANY code — this is mandatory, not optional. MUST TRIGGER on every request that writes code, implements a feature, fixes a bug, refactors, adds or changes tests, edits existing files, or produces any code diff whatsoever, no matter how small. Whenever you are about to use Edit, Write, or NotebookEdit on code, load this skill first. Apply think-before-coding, simplicity-first, surgical-changes, and goal-driven-execution principles. The ONLY exceptions are pure Q&A, code explanation with no edits, and single-character typo fixes.
---

# Coding Discipline

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## When to Use

Load this skill BEFORE you start editing when the task involves:
- Writing new code, functions, modules, or files
- Modifying existing code (bug fixes, feature additions, refactors)
- Adding tests or changing test behavior
- Any change where a diff will be produced

## When NOT to Use

- Pure questions ("how does X work?", "what does this code do?")
- Reading/explaining code without modifying it
- Single-character typo fixes
- Configuration-only changes that have no judgment calls

## 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Success Signals

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
