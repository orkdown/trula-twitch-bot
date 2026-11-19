import { config } from "./config.js";

const durationCache = new Map();

async function getYoutubeDuration(videoId) {
  if (!videoId) return 0;
  if (durationCache.has(videoId)) return durationCache.get(videoId);

  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+478",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const html = await res.text();
      const durMatch = html.match(/"approxDurationMs"\s*:\s*"(\d+)"/);
      if (durMatch) {
        const sec = Math.floor(parseInt(durMatch[1], 10) / 1000);
        durationCache.set(videoId, sec);
        return sec;
      }
      const lengthMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
      if (lengthMatch) {
        const sec = parseInt(lengthMatch[1], 10);
        durationCache.set(videoId, sec);
        return sec;
      }
    }
  } catch {}
  return 0;
}

export function formatTime(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export class TrulaClient {
  constructor() {
    this.token = config.trulaToken;
    this.restUrl = config.trulaRestUrl;
    this.wsUrl = config.trulaWsUrl;

    this.ws = null;
    this.wsTicket = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.isConnected = false;

    // In-memory real-time state cached from WebSocket
    this.cachedNowPlaying = null;
    this.currentTrackId = null;

    // Callbacks
    this.onTrackChange = null;
    this.onWsEvent = null;
  }

  // --- REST API METHODS ---

  async fetchRest(endpoint, options = {}) {
    const url = `${this.restUrl}/${endpoint}`;
    const headers = {
      token: this.token,
      "Content-Type": "application/json",
      "User-Agent": "TrulaTwitchBot/1.0",
      ...(options.headers || {}),
    };

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error("Неверный токен Trula (401 Unauthorized)");
      }
      let errText = "";
      try {
        const errJson = await res.json();
        errText = errJson.title || errJson.detail || JSON.stringify(errJson);
      } catch {
        errText = await res.text();
      }
      throw new Error(`Ошибка Trula API (${res.status}): ${errText}`);
    }

    if (res.status === 204) {
      return null;
    }
    return await res.json();
  }

  async getNowPlaying() {
    // 1. If we have live WS state with a playing track, use it
    if (this.cachedNowPlaying && this.cachedNowPlaying.state === "play") {
      return this.formatWsNowPlaying(this.cachedNowPlaying);
    }

    // 2. Fallback to REST API
    try {
      const data = await this.fetchRest("now-playing");
      if (!data || data.kind === "none" || (!data.order && !data.playlist)) {
        return null;
      }

      if (data.kind === "order" && data.order) {
        const ord = data.order;
        const track = ord.track || {};
        const title = track.title || "Неизвестный трек";

        // Fetch initiator from events if needed, or check cached initiator
        let initiator = this.cachedNowPlaying?.initiator?.displayName || null;
        if (!initiator && ord.event_id) {
          initiator = await this.resolveEventInitiator(ord.event_id);
        }

        let timing = "";
        if (ord.start_time !== null && ord.end_time !== null) {
          timing = `[${formatTime(ord.start_time)} - ${formatTime(ord.end_time)}]`;
        } else if (ord.start_time !== null) {
          timing = `[с ${formatTime(ord.start_time)}]`;
        }

        return {
          title,
          initiator: initiator || "Баллы канала",
          isPlaylist: false,
          platform: track.platform || "youtube",
          externalId: track.external_id || "",
          timing,
          url: track.platform === "youtube" ? `https://youtube.com/watch?v=${track.external_id}` : null,
        };
      }

      if (data.kind === "playlist" && data.playlist) {
        const pl = data.playlist;
        let externalId = "";
        if (pl.preview_url) {
          const match = pl.preview_url.match(/vi\/([a-zA-Z0-9_\-]+)\//);
          if (match) externalId = match[1];
        }

        return {
          title: pl.title || "Плейлист",
          initiator: "", // Музыка из плейлиста стримера: не пишем кто заказал!
          isPlaylist: true,
          platform: pl.platform || "youtube",
          externalId,
          timing: "",
          url: externalId ? `https://youtube.com/watch?v=${externalId}` : null,
        };
      }
    } catch (e) {
      console.error("[Trula] Ошибка при запросе now-playing:", e.message);
    }

    return null;
  }

  formatWsNowPlaying(wsData) {
    const track = wsData.track || {};
    const title = track.title || "Без названия";
    const isPlaylist =
      wsData.kind === "playlist" ||
      !wsData.initiator ||
      wsData.initiator?.displayName?.startsWith("Плейлист");
    const initiator = isPlaylist ? "" : (wsData.initiator?.displayName || "");
    const seekStr = formatTime(wsData.seek);
    const durationStr = track.durationText || formatTime(wsData.endTime);

    let timing = "";
    if (seekStr && durationStr) {
      timing = `[${seekStr} / ${durationStr}]`;
    } else if (seekStr) {
      timing = `[${seekStr}]`;
    }

    let url = null;
    if (track.platform === "youtube" && track.externalId) {
      url = `https://youtube.com/watch?v=${track.externalId}`;
    }

    return {
      title,
      initiator,
      isPlaylist,
      platform: track.platform || "youtube",
      timing,
      url,
    };
  }

  async getHudData() {
    const now = this.cachedNowPlaying;
    let isPlaying = now ? now.state === "play" : true;
    let title = "";
    let initiator = "";
    let isPlaylist = false;
    let platform = "youtube";
    let externalId = "";
    let thumbnail = "";
    let seek = 0;
    let duration = 0;

    if (now && now.track) {
      const track = now.track || {};
      title = track.title || "Без названия";
      isPlaylist =
        now.kind === "playlist" ||
        !now.initiator ||
        now.initiator?.displayName?.startsWith("Плейлист");
      initiator = isPlaylist ? "" : (now.initiator?.displayName || "");
      platform = track.platform || "youtube";
      externalId = track.externalId || track.external_id || "";
      seek = typeof now.seek === "number" ? Math.floor(now.seek) : 0;
      duration =
        typeof now.endTime === "number"
          ? Math.floor(now.endTime)
          : typeof track.duration === "number"
            ? Math.floor(track.duration)
            : 0;
    } else {
      // Fallback to REST API
      const restData = await this.fetchRest("now-playing").catch(() => null);
      if (!restData || restData.kind === "none" || (!restData.order && !restData.playlist)) {
        return { isPlaying: false, track: null };
      }

      if (restData.kind === "playlist" && restData.playlist) {
        const pl = restData.playlist;
        title = pl.title || "Плейлист";
        isPlaylist = true;
        initiator = "";
        platform = pl.platform || "youtube";
        if (pl.preview_url) {
          const match = pl.preview_url.match(/vi\/([a-zA-Z0-9_\-]+)\//);
          if (match) externalId = match[1];
        }
      } else if (restData.kind === "order" && restData.order) {
        const ord = restData.order;
        const trk = ord.track || {};
        title = trk.title || "Трек";
        platform = trk.platform || "youtube";
        externalId = trk.external_id || "";
        isPlaylist = false;
        initiator = (await this.resolveEventInitiator(ord.event_id)) || "Баллы канала";
        if (ord.start_time !== null && ord.end_time !== null) {
          duration = Math.floor(ord.end_time - ord.start_time);
        }
      }

      // Populate cachedNowPlaying so interval and WS stay synced
      if (!this.cachedNowPlaying) {
        this.cachedNowPlaying = {
          state: isPlaying ? "play" : "pause",
          seek: 0,
          endTime: duration,
          track: {
            title,
            externalId,
            platform,
            duration,
          },
          initiator: isPlaylist ? null : { displayName: initiator },
          kind: isPlaylist ? "playlist" : "order",
        };
      }
    }

    // Resolve thumbnail & duration if missing
    if (externalId) {
      thumbnail = `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg`;
      if (duration === 0) {
        duration = await getYoutubeDuration(externalId);
        if (this.cachedNowPlaying) {
          this.cachedNowPlaying.endTime = duration;
          if (this.cachedNowPlaying.track) {
            this.cachedNowPlaying.track.duration = duration;
          }
        }
      }
    }

    return {
      isPlaying,
      isPlaylist,
      track: {
        title,
        initiator,
        isPlaylist,
        platform,
        externalId,
        thumbnail,
        seek,
        duration,
        state: isPlaying ? "play" : "pause",
      },
    };
  }

  async resolveEventInitiator(eventId) {
    try {
      const data = await this.fetchRest("events?limit=20");
      if (data && data.events) {
        const ev = data.events.find((e) => e.id === eventId);
        if (ev && ev.initiator && ev.initiator.display_name) {
          return ev.initiator.display_name;
        }
      }
    } catch {}
    return null;
  }

  async getQueue(limit = 3) {
    try {
      const data = await this.fetchRest(`queue?limit=${limit}`);
      if (!data || !data.orders || data.orders.length === 0) {
        return [];
      }

      return data.orders.map((ord) => {
        const track = ord.track || {};
        return {
          id: ord.id,
          title: track.title || "Неизвестный трек",
          platform: track.platform || "youtube",
          externalId: track.external_id || "",
        };
      });
    } catch (e) {
      console.error("[Trula] Ошибка при получении очереди:", e.message);
      return [];
    }
  }

  async skipTrack() {
    // 1. Try REST next-track
    try {
      await this.fetchRest("actions/next-track", { method: "POST" });
      return true;
    } catch (e) {
      console.warn("[Trula] REST skip failed, trying WS requestChangeTrack:", e.message);
    }

    // 2. Fallback to WS command
    if (this.isConnected && this.ws) {
      this.sendWs({
        type: "requestChangeTrack",
        payload: { orderId: null, trackId: null, playlistId: null },
      });
      return true;
    }

    throw new Error("Не удалось пропустить трек");
  }

  async togglePlay() {
    return await this.fetchRest("actions/toggle-play", { method: "POST" });
  }

  async emergency(isActive) {
    return await this.fetchRest("actions/emergency", {
      method: "POST",
      body: JSON.stringify({ is_active: isActive }),
    });
  }

  // --- WEBSOCKET REAL-TIME CONNECTION ---

  async connectWs() {
    try {
      const tokenData = await this.fetchRest("ws-token");
      this.wsTicket = tokenData.token;
    } catch (e) {
      console.error("[Trula WS] Ошибка получения тикета:", e.message);
      this.scheduleReconnect();
      return;
    }

    const wsEndpoint = `${this.wsUrl}?ticket=${encodeURIComponent(this.wsTicket)}`;
    this.ws = new WebSocket(wsEndpoint);

    this.ws.onopen = () => {
      console.log("[Trula WS] Соединение установлено.");
      this.isConnected = true;
      // Request current play state
      this.sendWs({ type: "getPlayState" });
    };

    this.ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        this.handleWsFrame(frame);
      } catch (err) {
        console.error("[Trula WS] Ошибка парсинга кадра:", err.message);
      }
    };

    this.ws.onerror = (err) => {
      console.error("[Trula WS] Ошибка соединения:", err.message || err);
    };

    this.ws.onclose = (evt) => {
      console.warn(`[Trula WS] Соединение закрыто (код: ${evt.code}, причина: ${evt.reason || "нет"}).`);
      this.isConnected = false;
      this.cleanupWs();
      this.scheduleReconnect();
    };
  }

  handleWsFrame(frame) {
    if (!frame || !frame.type) return;

    switch (frame.type) {
      case "connected": {
        const payload = frame.payload || {};
        const interval = payload.ping_interval_ms || 25000;
        this.startHeartbeat(interval);
        break;
      }

      case "ping": {
        this.sendWs({ type: "pong" });
        break;
      }

      case "setTrack": {
        const payload = frame.payload;
        this.cachedNowPlaying = payload;
        const newTrackId = payload?.track?.id || payload?.id;

        if (newTrackId && newTrackId !== this.currentTrackId) {
          this.currentTrackId = newTrackId;
          if (this.onTrackChange && payload) {
            this.onTrackChange(this.formatWsNowPlaying(payload));
          }
        }
        if (this.onWsEvent) {
          this.onWsEvent("setTrack", payload);
        }
        break;
      }

      case "playState": {
        if (frame.payload) {
          if (!this.cachedNowPlaying) this.cachedNowPlaying = {};
          this.cachedNowPlaying.state = frame.payload.state;
          if (this.onWsEvent) {
            this.onWsEvent("playState", frame.payload);
          }
        }
        break;
      }

      case "orderAdded": {
        console.log(`[Trula WS] Новый заказ в очередь: ${frame.payload?.order?.track?.title || "трек"}`);
        if (this.onWsEvent) {
          this.onWsEvent("orderAdded", frame.payload);
        }
        break;
      }
    }
  }

  sendWs(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  startHeartbeat(intervalMs) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.sendWs({ type: "ping" });
    }, intervalMs);
  }

  cleanupWs() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log("[Trula WS] Попытка переподключения...");
      this.connectWs();
    }, 5000);
  }
}
