/**
 * The only module that reads the build-mode constants.
 *
 * Keeping the reads in one place means every other file branches on a plain
 * top-level `const`, which Rollup inlines and then folds away.
 */

/** True in the hosted build, where a Worker holds the Groq key. */
export const SERVICE_MODE = __RB_SERVICE_MODE__;

/** True in the self-hosted build, where the user supplies their own key. */
export const BYOK_MODE = !__RB_SERVICE_MODE__;

/** "" when the Worker serves this same origin, which is the intended shape. */
export const API_BASE_URL = __RB_API_BASE_URL__;
