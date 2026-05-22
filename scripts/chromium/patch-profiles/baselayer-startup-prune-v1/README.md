# BaseLayer Startup Prune v1

Experimental Chromium `headless_shell` source patch profile for BaseLayer.

This profile keeps the normal DevTools/CDP contract intact and trims startup
paths that are low-value for ephemeral Firecracker browser sessions:

- Lazy-load Origin Trials persistence instead of forcing it during browser
  context construction.
- Skip profile metrics registration for ephemeral headless contexts.
- Avoid the Linux DBus/Freedesktop secret key provider and use the POSIX key
  provider path only.
- Bind DevTools to IPv4 localhost only, avoiding the IPv6 fallback path.
- Skip loading the 200-percent Chrome resource pack in the non-embedded
  fallback path.

Use this profile only for A/B benchmarks against the marker-only
`startup-network-v1` profile until the matrix shows a stable improvement.
