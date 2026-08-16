/** Shortest query the global search accepts.
 *
 * Mirrors the `min_length` on the backend's /api/search — the header box
 * navigates on a debounce, so without this a single typed character fires
 * a real search that matches most of the library (and would 422). */
export const MIN_SEARCH_LENGTH = 2;

/** Page size for search results, matching the backend default. */
export const SEARCH_PAGE_SIZE = 20;
