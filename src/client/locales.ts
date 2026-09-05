/**
 * Debug toggle copy. The composer renders in the active locale; the toggle
 * registers one dictionary namespace under the plugin's own key so the
 * framework synthesizes the bound `t` seat on the component.
 *
 * @module dsh-debug-mode/client/locales
 */

/** Dictionary keys owned by the debug toggle. */
export type DebugToggleKey =
  | 'mode.debug'
  | 'mode.normal'
  | 'mode.plan'
  | 'aria.debugOn'
  | 'aria.enterDebug'
  | 'aria.switchFromPlan'
  | 'failure'

/** English copy. */
export const en: Readonly<Record<DebugToggleKey, string>> = {
  'mode.debug': 'Debug',
  'mode.normal': 'Normal',
  'mode.plan': 'Plan',
  'aria.debugOn': 'Debug mode is on; click to exit',
  'aria.enterDebug': 'Normal mode; click to enter debug',
  'aria.switchFromPlan': 'Plan mode is on; click to switch to debug',
  failure: 'Mode switch failed',
}

/** Simplified Chinese copy. */
export const zh: Readonly<Record<DebugToggleKey, string>> = {
  'mode.debug': '调试',
  'mode.normal': '标准',
  'mode.plan': '计划',
  'aria.debugOn': '调试模式已开启，点击退出',
  'aria.enterDebug': '标准模式，点击进入调试',
  'aria.switchFromPlan': '计划模式已开启，点击切换到调试',
  failure: '模式切换失败',
}

/** Dictionary namespace owned by the debug toggle. */
export const NS = 'dsh-debug'
