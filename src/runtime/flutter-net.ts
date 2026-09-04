/**
 * Flutter local-network configuration patches for Android and iOS. Patches are
 * inserted with a run marker and can be removed by the same marker, keeping
 * the user's own configuration intact. Only Android debug manifests and Apple
 * plist local-network exceptions are touched; production signing configs are
 * never modified here.
 *
 * @module dsh-debug-mode/runtime/flutter-net
 */

export const FLUTTER_NET_MARKER = 'dsh_debug_mode_lan'

const markerOpen = '<!-- ' + FLUTTER_NET_MARKER + ' -->'
const markerClose = '<!-- /' + FLUTTER_NET_MARKER + ' -->'

/** Add a marker-wrapped Internet/cleartext permission to an Android debug manifest. */
export function patchAndroidDebugManifest(
  source: string,
  comment: string,
): { code: string; changed: boolean } {
  const usesPermission = '<uses-permission android:name="android.permission.INTERNET" />'
  if (source.includes(FLUTTER_NET_MARKER)) return { code: source, changed: false }
  const wrapped =
    markerOpen + '\n    ' + usesPermission + ' <!-- ' + FLUTTER_NET_MARKER + ':' + comment + ' -->'
  if (source.includes('<uses-permission')) {
    const index = source.indexOf('<uses-permission')
    return {
      code: `${source.slice(0, index)}${wrapped}\n    ${source.slice(index)}`,
      changed: true,
    }
  }
  const manifestEnd = source.indexOf('<application')
  if (manifestEnd === -1) return { code: source, changed: false }
  return {
    code: `${source.slice(0, manifestEnd)}${wrapped}\n    ${source.slice(manifestEnd)}`,
    changed: true,
  }
}

/** Remove any marker-wrapped Android debug manifest patch. */
export function removeAndroidDebugManifest(source: string): { code: string; removed: boolean } {
  const lines = source.split('\n')
  const kept: string[] = []
  let removed = false
  let skipping = false
  for (const line of lines) {
    if (line.includes(markerOpen)) {
      skipping = true
      removed = true
      continue
    }
    if (line.includes(FLUTTER_NET_MARKER + ':') && line.includes('<uses-permission')) {
      skipping = false
      removed = true
      continue
    }
    if (skipping) {
      if (line.includes('<uses-permission')) skipping = false
      continue
    }
    kept.push(line)
  }
  return { code: kept.join('\n'), removed }
}

/** Add a marker-wrapped ATS local-network exception to an iOS/macOS Info.plist. */
export function patchAppleLocalNetwork(
  source: string,
  comment: string,
): { code: string; changed: boolean } {
  if (source.includes(FLUTTER_NET_MARKER)) return { code: source, changed: false }
  const body = [
    '<key>NSLocalNetworkUsageDescription</key>',
    '<string>' + comment + '</string>',
    '<key>NSAllowsLocalNetworking</key>',
    '<true/>',
  ].join('\n    ')
  const exception = markerOpen + '\n    ' + body + '\n    ' + markerClose
  const dictStart = source.indexOf('<dict>')
  if (dictStart === -1) return { code: source, changed: false }
  const insertAt = dictStart + '<dict>'.length
  return {
    code: `${source.slice(0, insertAt)}\n    ${exception}${source.slice(insertAt)}`,
    changed: true,
  }
}

/** Remove any marker-wrapped Apple plist patch. */
export function removeAppleLocalNetwork(source: string): { code: string; removed: boolean } {
  const open = markerOpen
  const close = markerClose
  const startIndex = source.indexOf(open)
  if (startIndex === -1) return { code: source, removed: false }
  const endIndex = source.indexOf(close, startIndex)
  if (endIndex === -1) return { code: source, removed: false }
  const newlineBefore = source.lastIndexOf('\n', startIndex - 1)
  const removeFrom = newlineBefore !== -1 ? newlineBefore : startIndex
  const end = endIndex + close.length
  return { code: `${source.slice(0, removeFrom)}${source.slice(end)}`, removed: true }
}
