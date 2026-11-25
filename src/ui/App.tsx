import { useKeyboard, useRenderer } from "@opentui/solid"

export function App() {
  const renderer = useRenderer()

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
      renderer.destroy()
    }
  })

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      padding={1}
    >
      <box border borderStyle="rounded" paddingX={2} paddingY={1} flexDirection="column" gap={1}>
        <text fg="#34d399">
          <strong>Quraa</strong>
        </text>
        <text fg="#a8bdb3">OpenTUI Solid + mpv foundation ready. Press q or Esc to exit.</text>
      </box>
    </box>
  )
}
