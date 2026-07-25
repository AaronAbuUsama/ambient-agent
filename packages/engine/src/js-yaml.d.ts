/**
 * js-yaml 4 ships no types and the only thing this workspace asks of it is "parse this frontmatter
 * into an unknown". A three-line shim beats a `@types/js-yaml` devDependency for one call.
 */
declare module "js-yaml" {
  export function load(input: string): unknown;
}
