# Manage this application with Paperplanes

BaseLayer is an independent application. Paperplanes is an external infra engineer
that can connect to its provider resources and use its owner-supplied health,
restart, and verification commands. Paperplanes does not contain BaseLayer code
or a BaseLayer-specific project type.

Copy `project.example.json` to `project.local.json`, fill in the actual sandbox ID,
and import it from your Paperplanes checkout:

```sh
npm run project:import -- /absolute/path/to/BaseLayer/deploy/paperplanes/project.local.json
```

The local configuration is ignored by Git. Importing it registers project and
service metadata; it does not create a sandbox, install BaseLayer, or restart a
service. Keep credentials out of the configuration file.

`verify.mjs` is this application's verification command. Install it at
`/opt/baselayer/deploy/paperplanes/verify.mjs` inside the sandbox. It creates a
Chromium session through BaseLayer, opens example.com, checks its title, and
releases the session. Paperplanes runs it through its generic service verification
tool only when requested.

## E2B image maintenance

These scripts belong to BaseLayer. Run them from this repository root with
`E2B_API_KEY` in your environment and `SCRY_SOURCE` pointing to a Scry checkout:

```sh
SCRY_SOURCE=/absolute/path/to/scry node deploy/paperplanes/build.mjs
node deploy/paperplanes/smoke.mjs
```

The image includes the API, managed Docker browser agent, and Scry. The smoke
command creates and deletes a separate temporary sandbox. The image blocks public
API access; browser clients run inside the sandbox. Build outputs live under
ignored `.deploy/`. The current recipe checks out BaseLayer revision
`6019f0cd2e95e4ea0a8afcba4dd3823029930975` and uses two CPUs and 4 GiB RAM.

A live sandbox needs its own Scry identity, collector endpoint, and collector key
in `/data/scry.env`, mode 0600. Those credentials are supplied through the provider's
authenticated file API and are never included in the image or project manifest.
E2B currently limits continuous runtime; the configured sandbox pauses with state
preserved and resumes when used. Browser sessions must be idle before a deliberate
pause/recovery test.
