---
name: gentle-ai-context-doctor
description: "Trigger: context doctor, prompt inflation, instruction audit, AGENTS.md, CLAUDE.md. Run the explicit advisory context audit."
license: Apache-2.0
metadata:
  author: "Denver2828"
  version: "2.0"
---

## Activation Contract

Use when asked to measure or inspect repository Claude/Codex instruction context, prompt inflation, duplicate rules, dead references, or standing-context growth.

## Hard Rules

- Invoke the doctor explicitly; never add it to hooks, startup, CI, or standing instructions.
- Scan the outer repository read-only. Never scan or write `src/**`.
- Keep raw paths and samples only under ignored `.claude/state/context-doctor/` or an external `--work` directory.
- Share only the receipt. Never share the private detailed report.
- Keep findings advisory for the full 28-day burn-in and afterward. Only an explicit human decision may promote a separate control.
- Do not claim behavioral backtesting for Codex/Engram or apply Claude line guidance causally to Codex.
- Treat corpus inventory as non-standing. Compare standing context only within one declared `coLoadDomain`; never add Claude and Codex totals together.
- Treat skill bodies as on-invocation content and skill listings as separate startup metadata. Respect Claude `disable-model-invocation`.
- Report dynamic hook payloads as `UNMEASURED` unless stdout or `additionalContext` was actually measured.
- Count `model_instructions_file` as Codex standing context and never attribute `project_doc_max_bytes` to the global user AGENTS.md.

## Decision Gates

| Need | Action |
| --- | --- |
| Repository instructions only | Run the default command. |
| User-level Claude/Codex instructions | Add `--include-user-scope` explicitly. |
| Private state outside the repository | Add `--work <external-directory>`. |
| Different advisory heuristics | Pass a reviewed JSON file with `--config`. |

## Execution Steps

1. Run `node .claude/tools/audit/bin/context-doctor.mjs --cwd .`.
2. Read the share-safe JSON receipt from stdout.
3. Inspect the private report only when a finding needs its local path or sample.
4. Apply the finding's declared action before considering a larger threshold.

## Output Contract

Return the receipt ID, phase, non-standing corpus metrics, per-domain standing/delta metrics, findings grouped by action (including `model-instructions-override` when `model_instructions_file` is declared), unmeasured checks, private report location, and whether human promotion remains pending.

## References

- `../../tools/audit/README.md` — context-doctor contract, privacy boundary, thresholds, and rollback.
