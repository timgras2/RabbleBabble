/**
 * The global fetch, bound to the global scope.
 *
 * Storing bare `fetch` on an object and calling it as `this.fetcher(...)`
 * detaches it from globalThis, and workerd rejects that with "Illegal
 * invocation: function called with incorrect `this` reference". It is an easy
 * mistake to make and an invisible one to test, because every test injects its
 * own fetcher and never exercises this default.
 */
export function defaultFetch(): typeof fetch {
  return globalThis.fetch.bind(globalThis);
}
