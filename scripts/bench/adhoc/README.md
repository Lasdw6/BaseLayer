# Ad Hoc Benchmark Scripts

This folder holds one-off or session-specific benchmark orchestration helpers that are not part of the core runtime/bootstrap path.

Keep the main `scripts/bench/` directory for stable, reusable entry points such as:

- host bootstrap
- runtime startup
- core benchmark runners
- cloud provisioning wrappers

Use `scripts/bench/adhoc/` for:

- temporary remote orchestration helpers
- one-shot packaging helpers
- benchmark-session-specific wrappers
- tuning scripts that are still experimental and not part of the default run path

If an ad hoc script becomes part of the standard workflow, promote it back into `scripts/bench/` and update docs accordingly.
