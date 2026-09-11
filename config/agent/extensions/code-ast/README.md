# Code AST extension dependencies

`typescript` is installed locally because code-ast uniquely owns its compiler API runtime.
The Pi coding-agent, Pi TUI, and TypeBox imports are host contracts instead: Core's bundled
extension loader supplies those modules from its patched, version-locked runtime. They are
optional peer dependencies so extension installation validates and records compatible
versions without installing a second, potentially incompatible Pi runtime inside the
extension artifact.

The core artifact smoke loads this extension through that bundled loader from an isolated
extracted artifact and verifies registration of `ast_references`, `ast_rename`, and
`ast_symbols`. A missing host alias or transitive dependency therefore fails artifact
creation while ordinary runtime loading remains nonfatal to Core availability.
