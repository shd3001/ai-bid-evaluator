# SDD ledger — plan: docs/superpowers/plans/2026-10-02-fastapi-backend-repair-plan.md

Scope: R01–R08, authorized 2026-10-03. R09–R11 and React are out of scope.

Ruling: This directory has no Git repository. Work in place, retain this ledger and tests instead of invoking Git-dependent task/commit scripts. Cost: changes have no Git rollback snapshot.

Pre-flight interfaces:
- R01 → R02/R03/R04: strict Pydantic v2 IDs, Decimal, three-state qualification; legacy conversion must be explicit and conservative.
- R04/R05 → R08: parsed chunks and evidence stored by document ID; no filename/display-name joins.
- R05 → R06/R07/R08: short independent sessions, idempotent checkpoints, atomic leases, revision conflicts.
- R06 → R08: typed schema validation, bounded retry, versioned cache; no network in tests.
- R07 → R09 (deferred): application/lifespan/health/OpenAPI only; business upload/routes remain third batch.

Execution: inline, test first. Dependency additions: pytest and Alembic in existing Python 3.11 virtual environment. No real model calls.

Task R01: complete — contract/prompt RED 10 failures → GREEN 10/10. Dependency lock and README finalized at batch integration.
Task R02: complete — regressions RED 14 failures → GREEN 14/14 (local extraction, IDs, negations, candidate limits and review serialization).
Task R03: complete — scoring/report RED 9 failures → GREEN; combined suite 44/44.
Ruling: R04 selects pdfplumber for page/table extraction; generic MarkItDown does not expose equivalent locations. No local OCR executable found. Provide injectable OCR confidence contract and explicitly flag unreadable pages for review. Cost: scanned material needs an externally configured OCR adapter or human transcription.

Task R04: complete within documented OCR boundary — parser/chunking RED 6 failures → GREEN 6/6; extended to 9 parser tests for real raster pages, table coordinates and long/multipage text. Conservative UTF-8 byte budget preserves every character and source coordinates.
Task R05: persistence/review RED missing infrastructure → GREEN 7/7; migrations, WAL/foreign keys, replay-before-version, atomic artifacts and non-destructive import verified.
Task R06: gateway RED 9 failures → GREEN 9/9; retries, authentication, timeout, JSON/schema categories, cancellation and versioned cache verified.
Task R07: app RED 4 failures → GREEN 4/4; lifecycle, readiness, CORS and public OpenAPI schemas verified.
Task R08: complete — runner RED 4 failures → GREEN 6/6, real workflows RED 2 failures → GREEN 2/2. Both CLI entries delegate to persistent application services and the same worker; atomic submission, noninteractive review, selected-run isolation and cancellation boundaries verified.

## Final review and corrections

One fresh read-only reviewer found 5 Important issues, no Critical issues. All Important issues were reproduced together (9 failing tests) and fixed in one TDD pass. No second review was dispatched.

Final: fixed rejected target remaining completed — `test_rejected_target_is_reexecuted_on_retry` RED→GREEN, suite 99/99. Target and downstream become stale; retry executes the target again. The full worker test also confirms rejection → retry → second review → successful completion. Identical extraction may reuse the validated cache; user edits are the explicit way to correct facts.

Final: fixed evidence-free disqualification — `test_unproven_failure_requires_review` RED→GREEN, suite 99/99. Unsupported failed checks/results become needs_review, including the legacy conversion boundary.

Final: fixed shared bidder price — `test_price_formula_never_uses_shared_bid_price` RED→GREEN, suite 99/99. Shared rule holds base price; each ScoreItem carries its own `inputs.bid_price` plus evidence. Missing inputs cannot produce a valid price score. Two bidder prices now yield different deterministic totals.

Final: fixed silent cross-chunk undercount — `test_independent_chunk_scores_are_retained_and_require_aggregation` RED→GREEN, suite 99/99. All alternatives and citations are retained; ambiguous final items remain missing until a reviewer supplies a rule-based aggregate. Confirm without editing fails validation.

Final: fixed profile evidence bypass — five profile/snapshot/opportunity regressions in `test_final_review_regressions.py` RED→GREEN, suite 99/99. Confirmed snapshots include verified registered sources; review validates each qualification; opportunities require per-rule checks backed by company documents. Integration tests cover legitimate recommendations and a rejected manual recommendation bypass.

Ruling: Ambiguous multi-chunk scores require explicit human aggregation rather than a guessed deduplication/sum. Cost: more manual checkpoints on long documents until a future structured fact aggregation model is validated.

Ruling: Confirmed profile qualification labels retain source wording, ignoring whitespace only. Cost: normalized synonyms may need the reviewer to restore source wording; this conservative check does not prove business validity, certificate expiry, or authenticity.

Review minors: retaining all conflicting alternatives was covered by the mandatory cross-chunk fix. Updating stale progress text was covered by delivery documentation. No deferred minors remain.

Review exclusions retained: R09 HTTP routes/upload bounds; R10 notice lifecycle/filters/source identity; R11 complete API/React handoff; real OCR and model accuracy; multi-machine/multi-tenant scale; factual truth of deliberate human decisions; exactly-once external model calls. These are scope/quality limits, not verified capabilities.

## Verification record

- Clean Windows Python 3.11 environment `.venv-batch-validation`, 65 pinned dependency packages installed from `requirements-lock.txt`.
- `.venv-batch-validation\Scripts\python.exe -m pytest -q`: **99 passed**, one upstream Starlette TestClient/httpx deprecation warning.
- `.venv-batch-validation\Scripts\python.exe -m pip check`: no broken requirements.
- Local wheel build and non-editable installation succeeded. Import from site-packages, final ScoreItem schema, packaged Alembic migration and DB readiness verified from outside source root.
- Actual Uvicorn HTTP live/ready checks succeeded; worker `--once` on an empty temporary DB and both CLI `--help` commands exited successfully. Temporary server stopped after checks.
- OpenAPI exported to `docs/openapi-batches-1-2.json`: 20 public schemas, two health paths. No business HTTP route completion is claimed.
- Parser comparison saved in `docs/document-parser-validation.json`; no OCR engine installed. Tests use fake model/search clients and synthetic documents; no paid/real model request was made.
- README and source plan synchronized. No Git repository exists, so changes and this ledger remain in place; no commit or PR was created.
