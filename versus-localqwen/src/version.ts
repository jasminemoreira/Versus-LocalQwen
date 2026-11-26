// Single source of the Versus version string. package.json carries the same value
// (a test asserts they match); the engine stamps it into state.json so a project can
// tell which Versus last opened it — the basis of the update notice.
export const VERSUS_VERSION = "0.15.0";
