# Browser denoiser provenance

Tau maintains `processor.js`, the realtime transport integration and the browser-module adaptations in `dtln.js`. The latter also contains Emscripten-generated glue and an embedded WebAssembly binary. Tau's integration authorship does not replace the attribution of that compiled dependency.

The dependency family is [DataDog/dtln-rs](https://github.com/DataDog/dtln-rs/tree/5bd53c00d3334615f9b03fa7775402ae2a39b616). Its `dtln_post.js` exposes the same wrapper and WASM symbols; the embedded binary contains DTLN Rust and TensorFlow Lite build references consistent with that implementation. The upstream reference commit identifies the source inspected for this review; it is **not a claim that this exact binary was built from that commit**.

`LICENSE.datadog`, `NOTICE.datadog` and `LICENSE-3rdparty.csv` preserve the upstream reference's notices verbatim. Its README/LICENSE/NOTICE identify MIT terms, while its package manifest retains a `Private` license label. The component inventory includes additional third-party terms and is not a complete, verified inventory of this particular binary.

`provenance.json` records the current JS and embedded WASM hashes. Tau introduced the asset in `88cb5e4c9` and subsequently adapted the browser module and initialization. This inventory cleanup leaves the executable asset unchanged.

Before public redistribution is approved, recover the exact binary source/build recipe, toolchain and model versions, and verify the required notices for the compiled TensorFlow Lite, Rust and model dependencies. Alternatively, produce and test a replacement build from pinned sources. The exact build is currently unresolved; do not interpret these reference notices as completion of that release review.
