# Work references

Each Tau instance assigns an immutable, increasing number to every work stream, across all squads. Use `#42` in conversations and labels and `42` in CLI/API lookups and URLs (`/squads/<squad>/work?ws=42`). Moving work does not change its number. Numbers are never reused; gaps are normal. Existing work is numbered by creation time, with UUID order breaking ties.

UUIDs remain internal keys and are still returned as `id`; API objects additionally return `number`. UUIDs and unique UUID prefixes remain accepted for lookup. Digits-only references prefer a work number; use a longer UUID prefix or full UUID when a numeric prefix collides. `#42` explicitly requests a numeric lookup (quote it in the shell and URL-encode the hash as `%23` in API paths). Ambiguous UUID prefixes fail rather than picking a stream. References are local to the instance, not globally unique across servers.

Examples: `tau workstream get 42`, `tau workstream get '#42'`, and `GET /api/workstreams/42`. Existing UUID links remain valid. Agent chats can use `[#42](tau:ws:42)`; bare work numbers in prose are also linked, while code and explicit PR/issue references are preserved.
