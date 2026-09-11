# Tau's pi 0.85.1 patch sources

Upstream release: `earendil-works/pi` at `d981de1229ef899957bbe968bc8dcda02a21f477` (`v0.85.1`).

The six TypeScript overlays preserve Tau's session event sanitization and persistence ordering, SDK exports, read-tool behavior, and host-provided extension module resolution. They were three-way merged from the 0.84.2 overlays against the new upstream source. The extension-loader merge retains upstream's Node SEA and bundled Node branches while keeping Tau's host-module fallback for unbundled artifacts.

Regenerate from a clean checkout of that upstream commit:

```sh
PI_MONO_DIR=/path/to/pristine/pi bun run patch:pi-coding-agent --write
```

Omit `--write` to verify the committed patch without changing it. Node.js 22.19 or newer and Bun are required. CI uses Node 24.

The script installs with the build-only `bun.lock` here and lifecycle scripts disabled. Bun's migration of this release's npm lock fails on duplicate workspace dependency entries, so this lock pins the isolated build dependencies explicitly. The upstream compiler pins remain TypeScript 5.9.3 and native-preview 7.0.0-dev.20260120.1. Disposable-clone package scripts use Bun in place of upstream's recursive npm calls; application manifests are not changed by regeneration.

The checks require pristine source outputs to match the verified published package, both independent overlay builds and patches to be byte-identical, sanitizer dataflow to pass, and all files outside the output allowlist to remain unchanged. The patch applies to the unbundled SDK used by Tau, not pi's standalone CLI bundles.

The separate pi-ai patch retains the two hard-plan-limit retry classifiers. Its old GLM-5.3 thinking-level override was removed because 0.85.1 already supplies that mapping (including `xhigh`). Keep the refreshed upstream model catalog intact.
