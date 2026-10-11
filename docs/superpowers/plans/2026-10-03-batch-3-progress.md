# SDD ledger — plan: docs/superpowers/plans/2026-10-02-fastapi-backend-repair-plan.md

Scope: R09–R11, authorized 2026-10-03. Existing R01–R08 are complete; React remains outside scope.

Ruling: No Git repository exists; execute in place and retain this ledger, tests and artifacts. Git-dependent workspace/commit scripts cannot run. Cost: no Git rollback snapshot.

Pre-flight interfaces:
- R04/R05 → R09: ParsedDocument/chunks, stable project/bidder IDs; upload uses generated paths and registers parsed local sources.
- R05/R08 → R09: RunService/ReviewService replay precedes version validation; HTTP DTOs exclude input snapshots, leases and paths.
- R10 → R11: deterministic notice filters must apply after model/manual assessment, so confirmed recommendations cannot bypass lifecycle and filters.
- R09/R10 → R11: both API and CLI retain shared services/workflows; fake external clients only.

Execution: inline, test first; one fresh final reviewer required by executing-plans. Existing Python 3.11 locked environment is reused. No real model requests.

Todos: R09 complete; R10 complete; R11 complete; final review complete.

Task R09: complete — 13 missing-route regressions RED → GREEN. Public routers, bounded upload, generated file paths, project/bidder association, deduplication, scoped pagination, safe DTOs, persisted review history/pending payload, results/evidence, report downloads and OpenAPI error schemas implemented. Exact 50 MiB file acceptance and +1-byte rejection tested. Existing multipart parser strips Windows drive prefixes; generated storage paths remain independent of filenames.

Ruling: Preserve the existing local-file parser and worker contracts; uploads parse in a thread before document registration, returning failed/empty material as 400 and quality-limited material as needs_review. Cost: the upload request includes parsing latency; production OCR and large complex files remain a quality boundary.

Task R10: metadata/filter/source tests RED 17 failures → GREEN 17/17; workflow lifecycle/source failure tests RED 5 failures → GREEN 5/5. Notices and source identities persisted; fetched evidence documents registered for API retrieval. Full suite verification recorded below before R11.

R10 full suite: 135 passed. Older no-key test intentionally updated: missing configuration is now a failed source, not a successful empty search. Positive eligibility fixture now includes an actual tender title and future explicit deadline.

Ruling: Extract lifecycle metadata conservatively from explicit labels in source text; labeled monetary units convert to yuan, local labeled deadline times use UTC+8, date-only/ambiguous fields remain unknown. Correction notices retain links but do not inherit eligibility automatically. Cost: unconventional layouts or formats may require corrected source text and a new run rather than guessing metadata.

R11 integration: API chains, CLI parity and restart/lease recovery exercised. RED evidence lookup and company query failures corrected by immutable content-based chunk IDs, retained variants and saved confirmed profiles. Exact opportunity report score RED→GREEN (86.75 stays a decimal string), model invalid JSON/retry and confirmed-profile reuse verified. Full suite: 140 passed; plan command in locked environment: 130 passed. Additional retry integration now included.

Ruling: Original parse chunks and workflow variants are both retained; chunk IDs include content and location, avoiding overwrite across run budgets. Company confirmation persists the current profile; edits increment its version. Cost: retained chunk variants increase storage; full enterprise profile asset/history management remains deferred.

Task R11: complete — API workflows, CLI parity, restart/lease recovery, retry/JSON handling, evidence access and confirmed-profile reuse verified. OpenAPI and synthetic examples exported; openapi-typescript 7.10.1 generated declarations, TypeScript 5.9.3 strict compilation checked (ignore-default-required option aligns optional request fields). Packaged wheel built and installed; real localhost HTTP upload/submission/cancel and empty worker start/stop verified. Real materials >=10 groups remain explicitly documented as a future quality baseline, not synthetic test evidence.

Final review: fresh read-only reviewer found 3 Important issues; no Critical or Minor. All 3 reproduced together (3 failing API integration tests) and fixed in one pass. No second reviewer dispatched.

Final: fixed registration deadline mistaken for submission deadline — test_registration_deadline_cannot_support_api_recommendation RED→GREEN; whole field labels required.
Final: fixed missing persisted manual transcription evidence — test_manual_ingest_evidence_is_immutable_queryable_and_reusable RED→GREEN; review, latest verified transcription and immutable chunk variants commit atomically; original variants/audit/snapshots retained.
Final: fixed stale company snapshot overwrites — test_stale_profile_edit_or_confirm_cannot_replace_latest_company RED→GREEN; current company revision compared in the write transaction; stale edit and confirmation both return 409.

Final: Ruling: Real model/OCR accuracy and >=10 real sanitized materials remain a documented future quality baseline — offline synthetic tests prove backend behavior only. Cost: business/extraction accuracy remains unmeasured.
Final: Ruling: Remote authentication and multi-tenant permissions remain outside the authorized local deployment scope. Cost: this build must remain local until that access-control work is completed.
Final: Ruling: Historical reports retain their generation as_of and source snapshots; no automatic expiry monitor is added. Cost: users must check notice deadlines when acting on an older report.

No deferred minors remain. Final verification after the single fix pass:
- Locked Python 3.11 environment: full suite 144 passed; plan unit/integration/api command 133 passed. One upstream Starlette TestClient/httpx deprecation warning.
- pip check: no broken requirements.
- OpenAPI: 19 paths, 22 unique stable operation IDs, 35 schemas; all references resolve.
- openapi-typescript 7.10.1 declarations and TypeScript 5.9.3 strict client example compile verified.
- Final wheel rebuilt and non-editable installed; SHA256 a7db79d9055a93b9cc3f1bbc99ac1284f3a3b7949312b2933e824e7af1bd26a1.
- Actual localhost HTTP live/ready/OpenAPI/upload/pending/cancel checks and independent worker --once empty queue succeeded; temporary server stopped and DB removed.
- docs/backend-api.md, docs/openapi.json, docs/api-types.d.ts, docs/api-client-example.ts, docs/api-examples.json and docs/backend-validation.json delivered.
- No paid model or real search call made, no React created, no Git repository/commit/PR. Work and ledger retained in place.
