import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface QuraaPaths {
  configDir: string
  cacheDir: string
  stateDir: string
  runtimeDir: string
  customStationsFile: string
  cacheStationsFile: string
  stateFile: string
  mpvSocketFile: string
  mpvPidFile: string
}

/** Resolve XDG configuration, cache, state, and runtime paths for Quraa. */
export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  uid: number = process.getuid?.() ?? 1000,
): QuraaPaths {
  const home = env.HOME || homedir()
  const configDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "quraa")
  const cacheDir = join(env.XDG_CACHE_HOME || join(home, ".cache"), "quraa")
  const stateDir = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "quraa")
  const runtimeDir = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "quraa")
    : `/tmp/quraa-${uid}`

  return {
    configDir,
    cacheDir,
    stateDir,
    runtimeDir,
    customStationsFile: join(configDir, "stations.json"),
    cacheStationsFile: join(cacheDir, "stations.json"),
    stateFile: join(stateDir, "state.json"),
    mpvSocketFile: join(runtimeDir, "mpv.sock"),
    mpvPidFile: join(runtimeDir, "mpv.pid"),
  }
}

/** Ensure a directory exists with private permissions for runtime/state storage. */
export function ensureDir(dir: string, mode = 0o700): string {
  mkdirSync(dir, { recursive: true, mode })
  return dir
}
