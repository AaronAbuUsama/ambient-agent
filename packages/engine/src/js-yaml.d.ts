/**
 * js-yaml 4 ships no types and the only thing this workspace asks of it is "parse this frontmatter
 * into an unknown". A three-line shim beats a `@types/js-yaml` devDependency for one call.
 */
declare module "js-yaml" {
  /** The all-scalars-are-strings schema; the one Flue's skill loader parses frontmatter with. */
  export const FAILSAFE_SCHEMA: unique symbol;
  export function load(input: string, options?: { schema?: typeof FAILSAFE_SCHEMA }): unknown;
}
