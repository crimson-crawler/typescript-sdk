/**
 * tlp.ts — TLP 2.0 marking values for the export surfaces (#374).
 *
 * One value set shared by the Artifact Manager / Report Generator surfaces and the
 * `/v1/artifact-enrich` engine. Case-sensitive: the five CISA TLP 2.0 markings. Every storage
 * artifact now carries its own `tlp` (contract #374), so `undefined` (the default on every method
 * here) omits the parameter: list methods return all markings, new artifacts default to `AMBER`,
 * and stored-artifact exports use the artifact's own TLP. Nothing defaults to `CLEAR`, because no
 * deterministic signal proves an input is public reference data.
 */

export const TLP_VALUES = [
  "CLEAR",
  "GREEN",
  "AMBER",
  "AMBER+STRICT",
  "RED",
] as const;

export type Tlp = (typeof TLP_VALUES)[number];

export const TLP_INVALID_MESSAGE = `tlp must be one of ${TLP_VALUES.join(", ")}`;

/** Validate a wire `tlp` argument, or `undefined` to omit it (server default: AMBER, or the
 *  artifact's own stored TLP on a stored-artifact export). Throws a `RangeError` — the SDK's
 *  argument-validation error — BEFORE any request is made. */
export function validateTlp(value: string | undefined): Tlp | undefined {
  if (value === undefined) return undefined;
  if ((TLP_VALUES as readonly string[]).includes(value)) return value as Tlp;
  throw new RangeError(TLP_INVALID_MESSAGE);
}
