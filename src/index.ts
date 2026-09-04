/**
 * Roster node half of the dsh-debug-mode bundle. Mirrors the ui-plan pattern:
 * the empty apply makes the row appear in the host Loader while the browser
 * half ships through exports["./client"] and the host controller through
 * exports["./host"].
 *
 * @module dsh-debug-mode
 */

export const name = 'dsh-debug-mode'

/** Roster entry — no host-side behavior lives here. */
export function apply(): void {}
