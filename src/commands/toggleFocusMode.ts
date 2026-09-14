import type ObservationCarPlugin from "../main";

export const TOGGLE_FOCUS_MODE_COMMAND_ID = "toggle-focus-mode";

/** Register F4.5's command for the currently paired note/editor. */
export function registerToggleFocusModeCommand(
  plugin: ObservationCarPlugin,
): void {
  plugin.addCommand({
    id: TOGGLE_FOCUS_MODE_COMMAND_ID,
    name: "Toggle focus mode",
    callback: () => {
      plugin.toggleFocusMode();
    },
  });
}
