import { sql, type SQL } from 'drizzle-orm'

/**
 * A jsonb expression that is ALWAYS an object: the column's value when it is a
 * jsonb object, else '{}'. COALESCE alone only guards SQL NULL — a column
 * holding a jsonb SCALAR (JSON null, a string, a number) makes jsonb_set throw
 * `cannot set path in scalar` (22023), which retry-looped persisted-session
 * message handling on 2026-08-26. jsonb_typeof(NULL) IS NULL, so the CASE
 * falls through to '{}' for SQL NULL too.
 *
 * Prefer {@link jsonbObjectRecovered} for any column whose contents matter:
 * this one DISCARDS a double-encoded object, which is silent data loss.
 */
export function jsonbObjectOrEmpty(target: SQL | unknown): SQL {
  return sql`CASE WHEN jsonb_typeof(${target}) = 'object' THEN ${target} ELSE '{}'::jsonb END`
}

/**
 * Like {@link jsonbObjectOrEmpty}, but RECOVERS a double-encoded object instead
 * of throwing it away.
 *
 * A "double-encoded" value is an object that was JSON-serialized twice, so it
 * landed in the jsonb column as a jsonb STRING whose text is the original JSON
 * (`"{\"source\":\"inbox\",...}"` rather than `{"source": "inbox", ...}`).
 * Live incident 2026-08-29 on the noah tenant: ~90% of every jsonb write —
 * across `messages.metadata`, `inbox.metadata` and `squad_activity.ref` alike —
 * arrived double-encoded until the API process was restarted, so this is a
 * property of the driver connection's state, not of any one call site.
 *
 * That corruption is RECOVERABLE on its own: drizzle's jsonb `mapFromDriverValue`
 * JSON.parses a string on read, so a double-encoded row still reads back as the
 * right object. What made it permanent was passing such a value through
 * `jsonbObjectOrEmpty` on the way to `jsonb_set`: the scalar failed the
 * `= 'object'` test and was replaced with '{}', erasing (for inbox deliveries)
 * `source: 'inbox'` and every summary the chat clients render their inbox cards
 * from. Recovering here keeps a driver-level relapse harmless.
 *
 * The unwrap is `value #>> '{}'` (the jsonb string's text) re-cast to jsonb, and
 * is attempted ONLY when that text is delimited like a JSON object. Postgres has
 * no non-throwing cast before 16's `pg_input_is_valid`, so the delimiter check is
 * what keeps this from erroring on an ordinary jsonb string: `'"oops"'::jsonb`
 * unwraps to `oops`, fails the check, and falls through to '{}' exactly as
 * before. Text that survives the check is JSON.stringify output by construction.
 */
export function jsonbObjectRecovered(target: SQL | unknown): SQL {
  return sql`CASE
    WHEN jsonb_typeof(${target}) = 'object' THEN ${target}
    WHEN jsonb_typeof(${target}) = 'string'
      AND left(btrim(${target} #>> '{}'), 1) = '{'
      AND right(btrim(${target} #>> '{}'), 1) = '}'
      THEN (${target} #>> '{}')::jsonb
    ELSE '{}'::jsonb
  END`
}
