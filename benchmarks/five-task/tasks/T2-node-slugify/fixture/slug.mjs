/**
 * Convert a title into a URL slug.
 *
 * Requirements (see README.md):
 * - lower-case ASCII letters, digits and single hyphens only
 * - Latin letters with diacritics lose their accents ("Crème" -> "creme")
 * - any run of other characters becomes one hyphen; no leading/trailing hyphen
 * - options.maxLength (default 60) truncates at a hyphen boundary when possible,
 *   never leaving a trailing hyphen
 * - an input with no usable characters returns options.fallback (default "untitled")
 */
export function slugify(title, options = {}) {
  throw new Error('slugify is not implemented yet');
}
