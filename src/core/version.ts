/**
 * The release of this package, as `version` in `package.json` gives it.
 *
 * Every script the build publishes names it too, in a comment on its first line, so that a copy on
 * a web server says which release it is without being loaded. A worker script left over from an
 * earlier release - the usual cause of `PROTOCOL_VERSION_MISMATCH` - is found that way. A unit
 * test holds this constant to `package.json`.
 */
export const VERSION = '0.1.0-beta.1';
