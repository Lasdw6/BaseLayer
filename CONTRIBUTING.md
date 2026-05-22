# Contributing

BaseLayer is early infrastructure code. Small, focused changes are easiest to
review.

Before opening a pull request:

```bash
npm run build
npm test
```

Benchmark and Firecracker changes should include:

- the exact profile name
- host shape and operating system
- whether the run is same-host, public `/v1`, or leaderboard-equivalent
- success count and p50 timings
- any known caveats

Please keep cloud credentials, private host metadata, local logs, benchmark
artifacts, and temporary archives out of commits.
