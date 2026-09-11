# CI and releases

Tau uses GitHub Actions to validate changes and publish distributable artifacts.
The workflows in [`.github/workflows`](../../.github/workflows) are authoritative.

## Pull-request checks

[Core CI](../../.github/workflows/ci.yml) runs typechecks, lint, builds, package
tests, subprocess and restart checks, and setup/updater verification. Native
macOS portability coverage is selected by the changed paths. Test completion
guards require every expected lane and test file to finish successfully.

The [CLA workflow](../../.github/workflows/cla.yml) checks contributor agreements.
See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the signing process.

Run `bun typecheck` and the relevant package test entrypoints before opening a
pull request. See [development](development.md) for local commands and isolated
test databases.

## CLI binaries

[CLI Binaries](../../.github/workflows/cli-binaries.yml) builds archives for Linux
and macOS on x64 and arm64, plus Windows x64. It publishes the archives, manifest,
and installer scripts to GitHub Releases. Main builds update `nightly`; version
tags identify versioned releases. Publication requires `TAU_RELEASES_ENABLED=true`.

The workflow publishes release assets without requiring SSH access to a host.
Each manifest records the source commit so installed binaries can be identified.

## Machine image

[Publish Images](../../.github/workflows/publish-images.yml) publishes
`ghcr.io/hire-tau/tau-machine` for exe.dev machine provisioning. Main builds are
selected by image-source changes; version tags and manual dispatch build the
image explicitly. Publication requires `TAU_RELEASES_ENABLED=true`.

See [the machine image README](../../packages/machine-image/README.md) for local
build commands and [machine upgrades](machines/upgrading.md) for running hosts.
DigitalOcean and other Ubuntu hosts use the setup/bootstrap scripts.

## Self-hosted builds and updates

Use [the setup toolkit](setup.md) to provision a host, or [local mode](../../apps/cli/README.md)
to run Tau on your own computer. The root [Dockerfile](../../Dockerfile) builds
an image containing Core, the CLI, web assets and embedded documentation.

For existing installations, use the updater appropriate to the installation
method. Deployment credentials belong to the operator's environment; they are
not needed to run the normal source validation checks.
