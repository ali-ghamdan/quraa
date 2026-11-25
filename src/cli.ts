#!/usr/bin/env bun

const args = Bun.argv.slice(2)
const cmd = args[0]

if (cmd === "--help" || cmd === "-h") {
  console.log("quraa — OpenTUI Quran radio player (mpv daemon)")
  console.log("Usage: quraa [--help | --version]")
  process.exit(0)
}

if (cmd === "--version" || cmd === "-v") {
  console.log("0.1.0")
  process.exit(0)
}

// Register Solid JSX transform before importing TSX when invoked via global `bun link` outside repo root.
const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
ensureSolidTransformPlugin()
const { render } = await import("@opentui/solid")
const { App } = await import("./ui/App.tsx")

await render(App, { exitOnCtrlC: false })
