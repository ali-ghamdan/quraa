import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePaths } from "../src/core/paths.ts"
import { App } from "../src/ui/App.tsx"

let setup: Awaited<ReturnType<typeof testRender>> | null = null
const tempDirs: string[] = []

afterEach(async () => {
  if (setup) {
    await setup.dispose()
    setup = null
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("resolvePaths", () => {
  test("respects XDG environment overrides", () => {
    const paths = resolvePaths(
      {
        HOME: "/home/tester",
        XDG_CONFIG_HOME: "/cfg",
        XDG_CACHE_HOME: "/cache",
        XDG_STATE_HOME: "/state",
        XDG_RUNTIME_DIR: "/run/user/42",
      },
      42,
    )

    expect(paths.configDir).toBe("/cfg/quraa")
    expect(paths.cacheDir).toBe("/cache/quraa")
    expect(paths.stateDir).toBe("/state/quraa")
    expect(paths.runtimeDir).toBe("/run/user/42/quraa")
    expect(paths.mpvSocketFile).toBe("/run/user/42/quraa/mpv.sock")
  })

  test("falls back to HOME defaults and /tmp/quraa-<uid>", () => {
    const paths = resolvePaths({ HOME: "/home/tester" }, 1001)

    expect(paths.configDir).toBe("/home/tester/.config/quraa")
    expect(paths.cacheDir).toBe("/home/tester/.cache/quraa")
    expect(paths.stateDir).toBe("/home/tester/.local/state/quraa")
    expect(paths.runtimeDir).toBe("/tmp/quraa-1001")
  })
})

describe("App baseline", () => {
  test("renders Quraa workspace via OpenTUI Solid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quraa-baseline-"))
    tempDirs.push(dir)
    const testPaths = resolvePaths(
      {
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, "cfg"),
        XDG_CACHE_HOME: join(dir, "cache"),
        XDG_STATE_HOME: join(dir, "state"),
        XDG_RUNTIME_DIR: join(dir, "run"),
      },
      1000,
    )
    const offlineFetch = (() =>
      Promise.reject(new Error("offline test"))) as unknown as typeof fetch

    setup = await testRender(
      () => <App paths={testPaths} fetchImpl={offlineFetch} />,
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()

    expect(frame).toContain("Quraa")
    expect(frame).toContain("1:All")
    expect(frame).toContain("IDLE")
  })
})
