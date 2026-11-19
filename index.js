import ws from "ws";
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = ws;
}

import { config } from "./config.js";
import { TrulaClient } from "./trula.js";
import { TwitchChatBot } from "./twitch.js";
import { HudServer } from "./hud.js";
import { AiDjService } from "./dj.js";

// Bulletproof error handling: keep process alive on any unexpected error
process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Неперехваченное исключение:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[CRITICAL] Необработанный промис:", reason);
});

console.log("=========================================");
console.log("   TRULA TWITCH CHAT BOT ДЛЯ СТРИМА     ");
console.log("=========================================");

if (!config.trulaToken) {
  console.error("[ERROR] TRULA_TOKEN не найден! Укажите токен в файле .env.");
  process.exit(1);
}

// 1. Initialize Trula Client
const trula = new TrulaClient();

// 2. Initialize Twitch Chat Bot
const twitch = new TwitchChatBot(trula);

// 3. Initialize HUD Widget Server for OBS
const hud = new HudServer(trula);

// 4. Initialize Free AI-DJ Service (TTS + Gemini)
const dj = new AiDjService(trula, hud);
hud.setAiDj(dj);

async function start() {
  console.log("[Init] Проверка подключения к Trula API...");
  try {
    const queue = await trula.getQueue(1);
    console.log(`[Init] Trula REST API подключен успешно! В очереди сейчас: ${queue.length} треков.`);
  } catch (err) {
    console.error("[Init] Ошибка при первичном запросе к Trula:", err.message);
  }

  // Connect to Trula WebSocket for real-time track updates
  trula.connectWs();

  // Connect to Twitch Chat
  twitch.connect();

  // Start HUD Server for OBS Studio Browser Source
  hud.start();

  if (dj.enabled) {
    console.log(
      `[AI-DJ] Голосовой радиоведущий активен (голос: ${dj.voice}, интервал: каждые ${dj.interval} треков)!`
    );
  }
}

start();
