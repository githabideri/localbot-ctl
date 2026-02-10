import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerLocalBotCommands } from "./src/commands.js";

export default function register(api: OpenClawPluginApi) {
  registerLocalBotCommands(api);
}
