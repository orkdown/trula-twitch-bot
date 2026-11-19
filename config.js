import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file manually so no external dependencies are needed
export function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

export const config = {
  // Trula Configuration
  trulaToken: process.env.TRULA_TOKEN || process.env.TRULA_API_TOKEN || "",
  trulaRestUrl: process.env.TRULA_REST_URL || "https://trula.io/api/v1/public",
  trulaWsUrl: process.env.TRULA_WS_URL || "wss://trula.io/ws/api",

  // Twitch Configuration
  twitchChannel: (process.env.TWITCH_CHANNEL || "").toLowerCase().replace(/^#/, ""),
  twitchBotUsername: (process.env.TWITCH_BOT_USERNAME || "").toLowerCase(),
  twitchBotOAuth: process.env.TWITCH_BOT_OAUTH || "", // format: oauth:xxxxxxxxxxxx

  // Skip & Vote Settings
  voteSkipThreshold: parseInt(process.env.VOTE_SKIP_THRESHOLD || "3", 10), // 0 to disable vote-skip (mod-only)
  commandCooldownMs: parseInt(process.env.COMMAND_COOLDOWN_MS || "3000", 10),

  // Music2YouTube Converter Integration
  converterApiUrl: process.env.CONVERTER_API_URL || "https://spotify.orkproxy.nx.kg/api/convert",
  autoConvertLinks: process.env.AUTO_CONVERT_LINKS !== "false",

  // HUD Widget Configuration
  hudPort: parseInt(process.env.HUD_PORT || "3333", 10),
  hudHost: process.env.HUD_HOST || "0.0.0.0",

  // Streamer Web-UI Remote Control
  remotePin: process.env.REMOTE_PIN || "7777",
};
