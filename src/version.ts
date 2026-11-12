// Single source of truth for the server version. release-please rewrites the
// literal below on release; every manifest that carries a version is listed in
// release-please-config.json's extra-files and kept in lockstep by
// tests/version-sync.test.ts. Keep the release marker on the export line only.
export const VERSION = '0.1.0'; // x-release-please-version
