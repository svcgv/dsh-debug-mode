import { describe, expect, it } from 'vitest'
import {
  patchAndroidDebugManifest,
  patchAppleLocalNetwork,
  removeAndroidDebugManifest,
  removeAppleLocalNetwork,
} from '../../../src/runtime/flutter-net.ts'

describe('flutter network patches', () => {
  it('patches and removes an Android debug manifest', () => {
    const manifest = '<manifest>\n    <application android:name="App" />\n</manifest>\n'
    const patched = patchAndroidDebugManifest(manifest, 'run-1')
    expect(patched.changed).toBe(true)
    expect(patched.code).toContain('android.permission.INTERNET')
    expect(patched.code).toContain('dsh_debug_mode_lan')
    const cleaned = removeAndroidDebugManifest(patched.code)
    expect(cleaned.removed).toBe(true)
    expect(cleaned.code).toBe(manifest)
    expect(patchAndroidDebugManifest(patched.code, 'run-1').changed).toBe(false)
  })

  it('inserts before existing uses-permission when present', () => {
    const manifest =
      '<manifest>\n    <uses-permission android:name="android.permission.CAMERA" />\n</manifest>\n'
    const patched = patchAndroidDebugManifest(manifest, 'r')
    expect(patched.code.indexOf('INTERNET')).toBeLessThan(patched.code.indexOf('CAMERA'))
  })

  it('patches and removes Apple plist local networking', () => {
    const plist =
      '<?xml version="1.0"?>\n<plist><dict><key>CFBundleName</key><string>App</string></dict></plist>\n'
    const patched = patchAppleLocalNetwork(plist, 'debug listener on LAN')
    expect(patched.changed).toBe(true)
    expect(patched.code).toContain('NSAllowsLocalNetworking')
    const cleaned = removeAppleLocalNetwork(patched.code)
    expect(cleaned.removed).toBe(true)
    expect(cleaned.code).toBe(plist)
    expect(patchAppleLocalNetwork(patched.code, 'r').changed).toBe(false)
  })

  it('leaves unrelated sources unchanged', () => {
    expect(patchAppleLocalNetwork('not a plist', 'r').changed).toBe(false)
    expect(removeAppleLocalNetwork('no marker').removed).toBe(false)
  })
})
