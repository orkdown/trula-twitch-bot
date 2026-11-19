import { EdgeTTS } from "@andresaya/edge-tts";
import { config } from "./config.js";

// Clean artist & title from parentheses, brackets, feats for natural speech
export function cleanTrackForSpeech(title) {
  if (!title) return "музыкальный трек";
  return title
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?(?:official|video|audio|clip|клип|релиз|remix|hd|4k).*?\)/gi, "")
    .replace(/\|\s*official.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class AiDjService {
  constructor(trulaClient, hudServer) {
    this.trula = trulaClient;
    this.hudServer = hudServer;
    this.channel = config.twitchChannel || "orkdown";
    this.enabled = config.aiDjEnabled;
    this.voice = config.aiDjVoice || "ru-RU-DmitryNeural";
    this.interval = config.aiDjTrackInterval || 5;
    this.cooldownMs = (config.aiDjCooldownSec || 40) * 1000;

    this.trackCounter = 0;
    this.lastSpeechTime = 0;
    this.isSpeaking = false;

    // Cache latest synthesized audio buffer
    this.latestAudioBuffer = null;
    this.latestSpeechText = "";
    this.lastEngine = "none";

    // Bind to Trula track changes
    if (this.trula) {
      const originalTrackChange = this.trula.onTrackChange;
      this.trula.onTrackChange = (trackInfo) => {
        if (originalTrackChange) originalTrackChange(trackInfo);
        this.handleTrackChange(trackInfo);
      };
    }
  }

  async handleTrackChange(trackInfo) {
    if (!this.enabled || !trackInfo || !trackInfo.title) return;

    this.trackCounter++;
    const now = Date.now();
    const isOrder = Boolean(trackInfo.initiator) && !trackInfo.isPlaylist;

    console.log(
      `[AI-DJ] Трек #${this.trackCounter}: "${trackInfo.title}" (Тип: ${isOrder ? "Заказ от " + trackInfo.initiator : "Плейлист"})`
    );

    // Decision Logic:
    // 1. Viewer Channel Points Order -> Always announce (if not on cooldown)
    // 2. Background Playlist -> Announce every N tracks (e.g. every 5 tracks)
    let shouldSpeak = false;

    if (isOrder) {
      if (now - this.lastSpeechTime >= 25000) {
        shouldSpeak = true;
      }
    } else {
      if (this.trackCounter % this.interval === 0 && now - this.lastSpeechTime >= this.cooldownMs) {
        shouldSpeak = true;
      }
    }

    if (shouldSpeak) {
      // Small 1.5s delay after track switch so the intro of the track plays first
      setTimeout(() => {
        this.triggerSpeech(trackInfo);
      }, 1500);
    }
  }

  async triggerSpeech(trackInfo = null) {
    if (this.isSpeaking) return;
    this.isSpeaking = true;

    try {
      if (!trackInfo) {
        trackInfo = await this.trula.getNowPlaying();
      }
      if (!trackInfo || !trackInfo.title) {
        this.isSpeaking = false;
        return;
      }

      console.log(`[AI-DJ] Генерация подводки для трека: "${trackInfo.title}"...`);
      const speechText = await this.generateText(trackInfo);
      console.log(`[AI-DJ] Текст подводки: "${speechText}"`);

      const audioBuf = await this.synthesizeWithFallback(speechText);
      if (audioBuf && audioBuf.length > 0) {
        this.latestAudioBuffer = audioBuf;
        this.latestSpeechText = speechText;
        this.lastSpeechTime = Date.now();

        // Broadcast to HUD to play audio in OBS
        const audioUrl = `/api/dj/latest.mp3?t=${Date.now()}`;
        if (this.hudServer) {
          this.hudServer.broadcast({
            type: "dj_speech",
            audioUrl,
            text: speechText,
            voice: this.voice,
            engine: this.lastEngine,
          });
        }
        console.log(`[AI-DJ] ✔ Озвучка успешно отправлена в OBS HUD (${audioBuf.length} байт, движок: ${this.lastEngine})!`);
      }
    } catch (err) {
      console.error("[AI-DJ] Ошибка генерации озвучки:", err.message);
    } finally {
      this.isSpeaking = false;
    }
  }

  // --- 1. TEXT GENERATION (Gemini Flash + Procedural Radio Templates) ---
  async generateText(trackInfo) {
    const cleanTitle = cleanTrackForSpeech(trackInfo.title);
    const isOrder = Boolean(trackInfo.initiator) && !trackInfo.isPlaylist;
    const initiator = isOrder ? trackInfo.initiator : "";
    const streamer = this.channel;

    // Try Google Gemini API if key is present
    if (config.geminiApiKey) {
      try {
        const geminiText = await this.callGemini(cleanTitle, initiator, streamer);
        if (geminiText) return geminiText;
      } catch (e) {
        console.warn("[AI-DJ] Gemini API ошибка, используем радио-шаблон:", e.message);
      }
    }

    // High-Energy Record / DFM Radio Templates
    return this.getRandomRadioTemplate(cleanTitle, initiator, streamer);
  }

  async callGemini(trackTitle, initiator, streamer) {
    const prompt = `Ты — энергичный, зажигательный радио-диджей на музыкальном стриме у ${streamer}.
Стиль: драйвовые, дерзкие радио-подводки в стиле станций Radio Record и DFM.
Твоя задача: ярко и коротко представить следующий трек для слушателей стрима.
${initiator ? `Этот трек заказал зритель с ником "${initiator}". Обязательно назови зрителя и похвали за сочный вкус!` : `Это трек из плейлиста стримера. Подогрей чат, спроси как им вайб!`}
Название трека: "${trackTitle}".

ПРАВИЛА:
1. Максимум 1-2 коротких предложения, до 20-25 слов.
2. Говори естественно, на русском языке, как живой харизматичный ведущий у микрофона.
3. НИКОГДА не упоминай донаты, деньги или рубли.
4. Выдай ТОЛЬКО готовый текст для голосового синтезатора (без кавычек, без смайлов, без скобок, без пояснений).`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 60,
        },
      }),
      signal: AbortSignal.timeout(3500),
    });

    if (res.ok) {
      const data = await res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (rawText) {
        return rawText.replace(/[*#_~`"]/g, "").replace(/\s+/g, " ").trim();
      }
    }
    return null;
  }

  getRandomRadioTemplate(cleanTitle, initiator, streamer) {
    if (initiator) {
      const orderTemplates = [
        `В эфире радио ${streamer}! Специальный плотный заказ от ${initiator} — встречаем ${cleanTitle}! Погнали!`,
        `Радио Рекорд на стриме у ${streamer}! ${initiator} врубает на полную громкость ${cleanTitle}! Делаем погромче, чат!`,
        `Чат, ловите сочный бэнгер! Для ${initiator} прямо сейчас звучит ${cleanTitle}. Полетели!`,
        `Специальный заказ в эфире ${streamer}! ${initiator} заряжает пушку ${cleanTitle}. Качаем вместе!`,
        `Мощный дроп в студии! ${initiator} ставит для нас ${cleanTitle}. Пошумите в чате!`,
        `На связи диджей стрима ${streamer}! Отличный выбор от ${initiator} — слушаем ${cleanTitle}!`,
      ];
      return orderTemplates[Math.floor(Math.random() * orderTemplates.length)];
    } else {
      const playlistTemplates = [
        `Врубаем на максимум! На волнах ${streamer} звучит ${cleanTitle}. Чат, как вам вайб?`,
        `Продолжаем музыкальный разгон на стриме у ${streamer}! В эфире ${cleanTitle}, погнали!`,
        `Не сбавляем обороты! Прямо сейчас на стриме у ${streamer} разрывает ${cleanTitle}!`,
        `Только лучшие бэнгеры в эфире! Встречаем ${cleanTitle} на главной волне ${streamer}!`,
        `Энергия на пределе! В эфире радио ${streamer}, слушаем трек ${cleanTitle}!`,
        `Разгоняем ритм! Для вас звучит ${cleanTitle}. Делаем громче колонки, чат!`,
      ];
      return playlistTemplates[Math.floor(Math.random() * playlistTemplates.length)];
    }
  }

  // --- 2. MULTI-TIER TTS SYNTHESIS ---
  async synthesizeWithFallback(text) {
    // 1. Primary: Microsoft Neural Edge TTS (ru-RU-DmitryNeural)
    try {
      const edgeAudio = await this.synthesizeEdge(text, this.voice, 3000);
      if (edgeAudio && edgeAudio.length > 0) {
        this.lastEngine = "EdgeTTS (" + this.voice + ")";
        return edgeAudio;
      }
    } catch (e) {
      console.warn(`[AI-DJ] Edge-TTS не ответил вовремя (${e.message}), переключаемся на резервный Google TTS...`);
    }

    // 2. Fallback: Google Translate TTS (ultra-fast, zero-dependency)
    try {
      const googleAudio = await this.synthesizeGoogle(text);
      if (googleAudio && googleAudio.length > 0) {
        this.lastEngine = "GoogleTTS (Fallback)";
        return googleAudio;
      }
    } catch (e) {
      console.error("[AI-DJ] Все движки TTS завершились с ошибкой:", e.message);
    }

    return null;
  }

  async synthesizeEdge(text, voice, timeoutMs = 3000) {
    const tts = new EdgeTTS({ voice: voice || "ru-RU-DmitryNeural" });
    const synthesizePromise = (async () => {
      await tts.synthesize(text);
      return await tts.toBuffer();
    })();

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${timeoutMs}ms`)), timeoutMs)
    );

    return await Promise.race([synthesizePromise, timeoutPromise]);
  }

  async synthesizeGoogle(text) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ru&client=tw-ob&q=${encodeURIComponent(text.slice(0, 200))}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }
    throw new Error(`Google TTS status: ${res.status}`);
  }
}
