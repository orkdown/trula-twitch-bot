import { config } from "./config.js";
import { convertMusicUrl, extractMusicUrl } from "./converter.js";

export class TwitchChatBot {
  constructor(trulaClient) {
    this.trula = trulaClient;
    this.channel = config.twitchChannel;
    this.username = config.twitchBotUsername;
    this.oauth = config.twitchBotOAuth;
    this.voteThreshold = config.voteSkipThreshold;
    this.cooldownMs = config.commandCooldownMs;

    this.ws = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.lastCommandTime = 0;

    // Track active skip votes
    this.skipVotes = new Set();
    this.currentTrackFingerprint = null;

    // Recent auto-converted links cache to avoid spamming
    this.recentConversions = new Map();

    // Reset votes when track changes
    if (this.trula) {
      this.trula.onTrackChange = (trackInfo) => {
        this.skipVotes.clear();
        this.currentTrackFingerprint = trackInfo?.title || null;
        console.log(`[Twitch] Трек сменился на: "${trackInfo?.title}". Голоса за скип сброшены.`);
      };
    }
  }

  connect() {
    if (!this.channel) {
      console.warn("[Twitch] Предупреждение: TWITCH_CHANNEL не указан в .env. Бот не сможет подключиться к чату.");
      return;
    }

    console.log(`[Twitch] Подключение к чату #${this.channel}...`);
    this.ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

    this.ws.onopen = () => {
      console.log("[Twitch] Соединение с IRC установлено. Авторизация...");
      this.isConnected = true;

      // Request capabilities (badges, mods, user tags)
      this.sendRaw("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");

      // Anonymous mode fallback if no oauth token provided
      if (this.oauth && this.username) {
        const pass = this.oauth.startsWith("oauth:") ? this.oauth : `oauth:${this.oauth}`;
        this.sendRaw(`PASS ${pass}`);
        this.sendRaw(`NICK ${this.username}`);
      } else {
        const anonNick = `justinfan${Math.floor(Math.random() * 80000 + 10000)}`;
        console.log(`[Twitch] Авторизация в режиме только для чтения (${anonNick}). Укажите TWITCH_BOT_OAUTH в .env для отправки сообщений.`);
        this.sendRaw(`NICK ${anonNick}`);
      }

      this.sendRaw(`JOIN #${this.channel}`);
    };

    this.ws.onmessage = (event) => {
      const message = event.data;
      this.handleIrcMessage(message);
    };

    this.ws.onerror = (err) => {
      console.error("[Twitch] Ошибка IRC WebSocket:", err.message || err);
    };

    this.ws.onclose = () => {
      console.warn("[Twitch] IRC соединение разорвано.");
      this.isConnected = false;
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log("[Twitch] Повторное подключение к чату...");
      this.connect();
    }, 5000);
  }

  sendRaw(str) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(str + "\r\n");
    }
  }

  sendMessage(text) {
    if (!this.oauth || !this.username) {
      console.log(`[Twitch (Read-Only Mode)] Ответ в чат: ${text}`);
      return;
    }
    this.sendRaw(`PRIVMSG #${this.channel} :${text}`);
  }

  handleIrcMessage(raw) {
    const lines = raw.split("\r\n");
    for (const line of lines) {
      if (!line) continue;

      // Ping-pong heartbeat
      if (line.startsWith("PING")) {
        this.sendRaw("PONG :tmi.twitch.tv");
        continue;
      }

      if (line.includes("PRIVMSG")) {
        this.parseChatMessage(line);
      } else if (line.includes("001 ")) {
        console.log(`[Twitch] Успешно зашли в чат канала #${this.channel}!`);
      } else if (line.includes("NOTICE") && line.includes("Login authentication failed")) {
        console.error("[Twitch] Ошибка аутентификации! Проверьте TWITCH_BOT_OAUTH и TWITCH_BOT_USERNAME в .env.");
      }
    }
  }

  parseChatMessage(line) {
    // Format: @tags :nick!nick@nick.tmi.twitch.tv PRIVMSG #channel :message
    let tags = {};
    let rest = line;

    if (line.startsWith("@")) {
      const spaceIdx = line.indexOf(" ");
      const tagStr = line.slice(1, spaceIdx);
      rest = line.slice(spaceIdx + 1);

      for (const pair of tagStr.split(";")) {
        const [k, v] = pair.split("=");
        tags[k] = v || "";
      }
    }

    const match = rest.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :?(.*)$/);
    if (!match) return;

    const senderNick = match[1];
    const text = match[2]?.trim();
    if (!text) return;

    // Check permissions
    const isBroadcaster = tags["badges"]?.includes("broadcaster") || senderNick.toLowerCase() === this.channel;
    const isMod = tags["mod"] === "1" || isBroadcaster;
    const displayName = tags["display-name"] || senderNick;
    const isCustomReward = Boolean(tags["custom-reward-id"]);

    if (!text.startsWith("!")) {
      // 1. Channel Points Custom Reward Redemption (user ordered via points)
      if (isCustomReward && config.autoConvertLinks) {
        const isDirectVideo =
          text.includes("youtube.com") ||
          text.includes("youtu.be") ||
          text.includes("vk.com/video") ||
          text.includes("vkvideo.ru");

        if (!isDirectVideo) {
          this.handleRewardAutoConvert(text, { displayName, senderNick });
          return;
        }
      }

      // 2. Automatic detection of external music links in normal chat (Spotify, Yandex, Apple, VK)
      if (config.autoConvertLinks) {
        const musicUrl = extractMusicUrl(text);
        if (musicUrl && !musicUrl.includes("youtube.com") && !musicUrl.includes("youtu.be")) {
          this.handleAutoConvert(musicUrl, { displayName, senderNick });
        }
      }
      return;
    }

    this.handleCommand(text, { senderNick, displayName, isMod, isBroadcaster });
  }

  async handleRewardAutoConvert(input, user) {
    const now = Date.now();
    const lastTime = this.recentConversions.get(input) || 0;
    if (now - lastTime < 15000) return; // 15s cooldown per exact query
    this.recentConversions.set(input, now);

    console.log(`[Twitch Reward] Обнаружен заказ за баллы от ${user.displayName}: "${input}"`);
    const res = await convertMusicUrl(input);
    if (res && res.youtubeUrl) {
      const trackLabel = res.artist ? `${res.artist} - ${res.title}` : res.title;
      this.sendMessage(
        `@${user.displayName} 🎵 "${trackLabel}" найден на YouTube! Trula требует прямую ссылку (баллы возвращены). Закажите трек повторно по этой ссылке: ${res.youtubeUrl}`
      );
    } else if (res && res.isVkMusic) {
      this.sendMessage(`@${user.displayName} ⚠️ ${res.message}`);
    } else if (res && res.isVkVideo) {
      this.sendMessage(`@${user.displayName} ℹ️ ${res.message}`);
    } else {
      this.sendMessage(
        `@${user.displayName} ⚠️ По запросу "${input}" не удалось найти трек. Уточните "Исполнитель - Трек" или используйте команду !link`
      );
    }
  }

  async handleAutoConvert(musicUrl, user) {
    const now = Date.now();
    const lastTime = this.recentConversions.get(musicUrl) || 0;
    if (now - lastTime < 60000) return; // 1 min cooldown per URL
    this.recentConversions.set(musicUrl, now);

    console.log(`[Twitch] Обнаружена внешняя музыкальная ссылка от ${user.displayName}: ${musicUrl}`);
    const res = await convertMusicUrl(musicUrl);
    if (res && res.youtubeUrl) {
      const trackLabel = res.artist ? `${res.artist} - ${res.title}` : res.title;
      this.sendMessage(`@${user.displayName} 🎵 "${trackLabel}" найден на YouTube! Ссылка для заказа за баллы: ${res.youtubeUrl}`);
    } else if (res && res.isVkMusic) {
      this.sendMessage(`@${user.displayName} ⚠️ ${res.message}`);
    } else if (res && res.isVkVideo) {
      this.sendMessage(`@${user.displayName} ℹ️ ${res.message}`);
    }
  }

  async handleCommand(cmdText, user) {
    const args = cmdText.split(" ");
    const command = args[0].toLowerCase();

    // Command Cooldown check (except for mods/streamer)
    const now = Date.now();
    if (!user.isMod && now - this.lastCommandTime < this.cooldownMs) {
      return;
    }

    try {
      switch (command) {
        case "!help":
        case "!commands":
        case "!команды":
        case "!помощь": {
          this.lastCommandTime = now;
          this.sendMessage(
            "📖 Музыкальные команды: !song — текущий трек | !queue — очередь | !link <ссылка/название> — найти трек для заказа | !skip — голосование за скип | !yt — ссылка на YouTube"
          );
          break;
        }

        case "!song":
        case "!np":
        case "!track":
        case "!музыка":
        case "!трек": {
          this.lastCommandTime = now;
          const current = await this.trula.getNowPlaying();
          if (!current) {
            this.sendMessage("🔇 Сейчас ничего не играет или плеер Trula остановлен.");
            return;
          }

          let response = `🎵 Сейчас играет: ${current.title}`;
          if (current.initiator) {
            response += ` | Заказал(а): ${current.initiator}`;
          }
          if (current.timing) {
            response += ` ${current.timing}`;
          }

          this.sendMessage(response);
          break;
        }

        case "!yt":
        case "!songlink":
        case "!ссылка": {
          this.lastCommandTime = now;
          const current = await this.trula.getNowPlaying();
          if (current && current.url) {
            this.sendMessage(`🔗 Ссылка на трек: ${current.url}`);
          } else if (current) {
            this.sendMessage(`🎵 Трек: ${current.title} (${current.platform})`);
          } else {
            this.sendMessage("🔇 Сейчас ничего не играет.");
          }
          break;
        }

        case "!convert":
        case "!link":
        case "!к": {
          this.lastCommandTime = now;
          const queryOrUrl = args.slice(1).join(" ").trim();
          if (!queryOrUrl) {
            this.sendMessage(`@${user.displayName}, укажите ссылку или название трека: !link <ссылка или Исполнитель - Трек>`);
            return;
          }

          const res = await convertMusicUrl(queryOrUrl);
          if (res && res.youtubeUrl) {
            const trackLabel = res.artist ? `${res.artist} - ${res.title}` : res.title;
            this.sendMessage(`@${user.displayName} 🎵 "${trackLabel}" -> YouTube ссылка для заказа за баллы: ${res.youtubeUrl}`);
          } else if (res && res.isVkMusic) {
            this.sendMessage(`@${user.displayName} ⚠️ ${res.message}`);
          } else if (res && res.isVkVideo) {
            this.sendMessage(`@${user.displayName} ℹ️ ${res.message}`);
          } else {
            this.sendMessage(`@${user.displayName}, не удалось найти трек на YouTube. Попробуйте написать точное название: !link Исполнитель - Трек`);
          }
          break;
        }

        case "!queue":
        case "!очередь": {
          this.lastCommandTime = now;
          const queue = await this.trula.getQueue(3);
          if (!queue || queue.length === 0) {
            this.sendMessage("📋 Очередь пуста. Заказывайте треки за баллы канала!");
            return;
          }

          const items = queue.map((q, idx) => `${idx + 1}. ${q.title}`).join(" | ");
          this.sendMessage(`📋 В очереди (${queue.length}): ${items}`);
          break;
        }

        case "!skip":
        case "!скип": {
          const current = await this.trula.getNowPlaying();
          if (!current) {
            this.sendMessage("🔇 Сейчас нечего пропускать.");
            return;
          }

          // 1. Moderator / Streamer Instant Skip
          if (user.isMod) {
            await this.trula.skipTrack();
            this.skipVotes.clear();
            this.sendMessage(`⏭️ Трек "${current.title}" пропущен модератором @${user.displayName}.`);
            return;
          }

          // 2. Viewer Vote-Skip
          if (this.voteThreshold <= 0) {
            this.sendMessage(`⚠️ Пропуск трека разрешен только стримеру и модераторам.`);
            return;
          }

          if (this.skipVotes.has(user.senderNick)) {
            this.sendMessage(`@${user.displayName}, вы уже голосовали за скип этого трека! [${this.skipVotes.size}/${this.voteThreshold}]`);
            return;
          }

          this.skipVotes.add(user.senderNick);
          const currentVotes = this.skipVotes.size;

          if (currentVotes >= this.voteThreshold) {
            await this.trula.skipTrack();
            this.skipVotes.clear();
            this.sendMessage(`⏭️ Трек "${current.title}" пропущен голосованием зрителей (${currentVotes}/${this.voteThreshold})!`);
          } else {
            this.sendMessage(`🗳️ Голос за скип от @${user.displayName} учтен! [${currentVotes}/${this.voteThreshold}]. Напишите !skip для голосования.`);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[Twitch] Ошибка при обработке команды ${command}:`, err.message);
    }
  }
}
