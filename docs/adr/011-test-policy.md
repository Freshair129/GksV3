# ADR 011 — Test policy: when written, when run, what's required

- **Status:** accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Context tag:** testing, ci, dev-process, quality-gate

## Context

GKS grew from 0 to 240+ tests across 32 test files in roughly six
weeks. Test practice has been consistent throughout the build — tests
written alongside features, run locally before push, run in CI on every
PR — but it lives only in lived practice and CI YAML, not in a written
contract.

That works while the same author writes everything. It will not survive
a second contributor who reads `SCOPE.md` + ADRs and asks *"how strict
is the test bar here?"*. Drift is easy: ship a feature without tests
"because the type system catches it", or pile on snapshot tests that
freeze data shapes prematurely, or push a 5-minute test suite that
nobody runs locally.

This ADR pins the practice that worked.

## Decision

### When tests are written

**Tests are part of the feature, in the same commit as the
implementation.** Not a follow-up. Not a separate PR. The boundary is
the commit, not the file.

A commit that adds public surface (a class, a function, a flag, a tool,
a frontmatter field) without tests requires a written rationale in the
commit message. "Will add tests later" is not a rationale.

This rules out both extremes:
- *Strict TDD* — tests-first ceremony doesn't fit the code-and-iterate
  flow we actually use, and Phase 4 microtask codegen has its own
  acceptance-test gate (see below).
- *Test-after-merge* — incentive to never write them.

### When tests run

| Trigger | What runs | Cost | Gating |
|---|---|---|---|
| **dev loop** (focused) | `npx vitest run path/to/file.test.ts` | sub-second | none — fast feedback |
| **dev loop** (full) | `npx vitest run` | ~14 s | none |
| **pre-commit hook** | `typecheck` + `lint` + `msp:validate` | ~3 s | block on fail |
| **pre-push** (recommended, not enforced) | `npx vitest run` (full) | ~14 s | local only |
| **CI on push** | typecheck + full test suite × Node 20 + Node 22 | ~30–60 s × 2 | required for PR merge |
| **PR merge** | all CI checks green | — | required |
| **P3.5 / P4 microtask codegen** | `acceptance_tests` per task YAML | per-task | retry loop, escalate to T2 after `max_retries` |
| **P6 audit** | full suite + integration tests + drift checks (`npm run check-sync`) | minutes | required before deploy |

**Pre-commit deliberately does NOT run the test suite.** 14 s on every
commit is enough friction that people start using `--no-verify`. Push
is the right gate for the full suite; CI is the enforced gate. Local
pre-push is recommended but advisory — the cost of one CI failure is
not high enough to mandate it.

### Test boundaries (3 tiers)

Tests live in `test/` mirroring `src/` paths and are organised into
three tiers — every test should be obvious which tier it belongs to:

| Tier | Location | Purpose | Speed | Network |
|---|---|---|---|---|
| **unit** | `test/<area>/*.test.ts` | one class / function with mocked collaborators | < 100 ms | never |
| **integration** | `test/integration/*.test.ts` | 2-3 components wired through real interfaces, in-process | < 1 s | never (real services gated by env) |
| **E2E** | `test/cli/`, `test/mcp/` | spawn subprocess or in-memory transport, full surface round-trip | 1-5 s | never |

The hard rule for all three: **hermetic by default**. `GKS_EMBEDDER=mock`
is set in CI so no test ever needs Ollama / OpenAI to pass. Tests that
*want* to exercise real services (live rerank server, real pgvector,
real Anthropic API) opt in via env gate (`it.skipIf(!process.env['…'])`)
— never opt-out.

### What's required

For any commit that adds or changes public surface:

- [ ] **Happy path test** — the obvious correct call returns the obvious correct result.
- [ ] **At least one edge case** — empty input, missing field, invalid value, namespace boundary, concurrent access. Pick what matters.
- [ ] **Failure mode** — when the function throws / rejects, the test asserts *what* it throws (message regex), not just *that* it throws.
- [ ] **Surface coverage** — if the feature is reachable via TS + CLI + MCP, at least one E2E test per surface (the CLI test for `--linked-symbol`, the MCP test for `gks_lookup_by_symbol`). Not full duplication; one round-trip per surface is enough to catch wiring breaks.
- [ ] **Hermetic** — runs offline, no flakes, no time-of-day deps.

For changes that don't add surface (refactor, perf, doc):

- [ ] **Existing tests still pass.** That's the bar.
- [ ] If the refactor is non-trivial, at least one test that would have caught the regression you were chasing — or call it "test gap accepted" in the commit message.

### What is explicitly NOT required

- **Coverage thresholds.** Coverage is reported (CI artifact, optional) but not gated. Goal-displacement risk is too high.
- **Snapshot tests for arbitrary data shapes.** Snapshots are fine for stable serialisations (JSONL row layouts, frontmatter rendering) where the format itself is the contract. They are not fine for "every-shape-of-output" tests, which freeze internal representations and cause review noise.
- **Duplicate tests across tiers.** If the unit test covers it, the E2E doesn't need to re-cover it; E2E exists to catch wiring + transport bugs the unit tests miss.

## Consequences

**Positive**

- **New contributor onboarding.** The expected bar is written down. "Read SCOPE.md, then read ADR-011 — that's the test contract."
- **Drift detection.** A PR that ships public surface without tests fails the bar visibly, even if CI passes.
- **Incentive alignment.** Tests live with the feature, so the author who knows the most about the change writes the tests.
- **Cost-aware gates.** Pre-commit stays fast, push stays optional, CI does the heavy lift. Nobody is rewarded for using `--no-verify`.

**Negative**

- **Friction on every PR.** Adding a 5-line helper now requires a 10-line test — sometimes the test is longer than the code. Accepted: tests are documentation of intent, not just verification.
- **Coverage isn't enforced.** A motivated author *could* test only the happy path and ship. Reviewer still has to check the diff. The bar lives in social practice + ADR, not in tooling.
- **Hermeticity costs realism.** Mock embedder produces deterministic vectors that don't reflect Ollama's actual behaviour. We mitigate with opt-in integration tests but do not require them in CI.

## Alternatives considered

1. **Strict TDD** — write a failing test first, code to pass it. *Rejected.* Forces a workflow that doesn't fit code-and-iterate or P3.5 codegen. The acceptance-test gate inside microtask codegen already gives us "tests-first" semantics where it matters most (LLM-generated code).

2. **Coverage threshold as a CI gate** (e.g. fail if branch coverage < 85%). *Rejected.* Goal-displacement risk: people optimise for the metric instead of for risk. We may add coverage as a *report* later — not as a gate.

3. **No formal policy** — keep the tribal knowledge. *Rejected* in light of this ADR existing because we noticed the gap.

4. **Pre-commit runs tests** — slower but stronger gate. *Rejected.* 14 s is past the threshold where developers start using `--no-verify` to ship. CI is the right enforcement point.

5. **Per-tier required-coverage matrix** ("unit tests required for libs, E2E required for CLI"). *Rejected* as over-spec. The matrix above gives orientation; the per-feature checklist gives the bar.

## What this changes in practice

- `CHANGELOG.md` "Tests" footer — every release section already lists test count. This ADR makes that load-bearing: a release that drops the test count without explanation is a regression.
- PR template — `.github/PULL_REQUEST_TEMPLATE.md` encodes the surface-coverage + verification checklists.
- New surface review — reviewers reject PRs that ship public API without at least the happy-path + edge-case + failure-mode trio.
- `npm test` is the authoritative command. Don't add new test scripts; if you need a different invocation, use `vitest run <pattern>` directly.

## References

- `vitest.config.ts` — runner config (Node 20 + 22 matrix in CI)
- `.github/workflows/ci.yml` — CI gate
- `package.json` `scripts.test` — `vitest run` (full suite)
- ADR 008 — scope (testing is part of "what GKS commits to ship", in scope)
- ADR 010 — example of the "+8 unit / +1 CLI / +1 MCP" pattern this ADR codifies
- FRAMEWORK_MASTER_SPEC §6.2 — phase-by-phase test artefacts (acceptance / unit / audit)
- FRAMEWORK_MASTER_SPEC §8.3 — `acceptance_tests:` requirement on every micro-task YAML
