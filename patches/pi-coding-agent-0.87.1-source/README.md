# Tau's pi 0.87.1 patch sources

Upstream release: `earendil-works/pi` at `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` (`v0.87.1`).

The six TypeScript overlays preserve Tau's session event sanitization and persistence ordering, SDK exports, read-tool behavior, and host-provided extension module resolution. They were three-way merged from the 0.85.1 overlays against the new upstream source. Upstream 0.86-0.87 reworked agent-session persistence around canonical session context boundaries and entry IDs; the merge keeps Tau's sanitizer passes and `session_message_persisted` emission on top of upstream's entry-ID bookkeeping (system messages now persist too, matching upstream's widened regular-role guard). The extension-loader merge keeps upstream's `resolutionOptions` restructuring and async virtual modules while retaining Tau's host-module fallback for unbundled artifacts.

Regenerate from a clean checkout of that upstream commit:

```sh
PI_MONO_DIR=/path/to/pristine/pi bun run patch:pi-coding-agent --write
```

Omit `--write` to verify the committed patch without changing it. Node.js 22.19 or newer and Bun are required. CI uses Node 24.

The script installs with the build-only `bun.lock` here and lifecycle scripts disabled. Bun cannot migrate this release's npm lock (duplicate workspace dependency entries), so this lock pins the isolated build dependencies explicitly. The upstream compiler pins remain TypeScript 5.9.3 and native-preview 7.0.0-dev.20260120.1. Disposable-clone package scripts use Bun in place of upstream's recursive npm calls; application manifests are not changed by regeneration.

The checks require pristine source outputs to match the verified published package, both independent overlay builds and patches to be byte-identical, sanitizer dataflow to pass, and all files outside the output allowlist to remain unchanged. The patch applies to the unbundled SDK used by Tau, not pi's standalone CLI bundles.

The separate pi-ai patch retains the two hard-plan-limit retry classifiers (upstream 0.87.1 has not absorbed them). Keep the refreshed upstream model catalog intact.
