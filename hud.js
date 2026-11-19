import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { convertMusicUrl } from "./converter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function isAuthorized(req, body, parsedUrl) {
  const pinHeader = req.headers["x-pin"];
  const pinQuery = parsedUrl.searchParams.get("pin");
  const pinBody = body?.pin;
  const expected = String(config.remotePin || "7777");
  return pinHeader === expected || pinQuery === expected || pinBody === expected;
}

export class HudServer {
  constructor(trulaClient) {
    this.trula = trulaClient;
    this.port = config.hudPort || 3333;
    this.host = config.hudHost || "0.0.0.0";
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
    this.syncInterval = null;

    // Hook up Trula real-time events
    if (this.trula) {
      const prevWsEvent = this.trula.onWsEvent;
      this.trula.onWsEvent = (type, payload) => {
        if (typeof prevWsEvent === "function") {
          prevWsEvent(type, payload);
        }
        this.handleTrulaEvent(type, payload);
      };
    }
  }

  start() {
    this.httpServer = http.createServer(async (req, res) => {
      // CORS headers for all responses
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pin");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = parsedUrl.pathname;

      // 1. OBS HUD Widget
      if (pathname === "/" || pathname === "/hud" || pathname === "/index.html") {
        const filePath = path.join(__dirname, "hud.html");
        try {
          const html = fs.readFileSync(filePath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Ошибка загрузки виджета HUD: " + e.message);
        }
        return;
      }

      // 2. Streamer Web-UI Remote Control Page
      if (pathname === "/remote" || pathname === "/dashboard") {
        const filePath = path.join(__dirname, "remote.html");
        try {
          const html = fs.readFileSync(filePath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Ошибка загрузки пульта управления: " + e.message);
        }
        return;
      }

      // 3. API: Now Playing Data (Public for HUD)
      if (pathname === "/api/now-playing") {
        try {
          const data = await this.trula.getHudData();
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // 4. API: Remote Auth Check
      if (pathname === "/api/remote/auth" && req.method === "POST") {
        const body = await parseJsonBody(req);
        const expected = String(config.remotePin || "7777");
        const success = String(body.pin || "") === expected;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success }));
        return;
      }

      // 5. Protected Remote Control Endpoints
      if (pathname.startsWith("/api/remote/")) {
        const body = req.method === "POST" ? await parseJsonBody(req) : {};
        if (!isAuthorized(req, body, parsedUrl)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Неверный PIN-код доступа!" }));
          return;
        }

        try {
          if (pathname === "/api/remote/toggle-play" && req.method === "POST") {
            await this.trula.togglePlay();
            if (this.trula.cachedNowPlaying) {
              const wasPlay = this.trula.cachedNowPlaying.state === "play";
              this.trula.cachedNowPlaying.state = wasPlay ? "pause" : "play";
              this.broadcast({
                type: "state_change",
                state: this.trula.cachedNowPlaying.state,
                seek: this.trula.cachedNowPlaying.seek,
                track: this.trula.cachedNowPlaying.track,
              });
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
            return;
          }

          if (pathname === "/api/remote/skip" && req.method === "POST") {
            await this.trula.skipTrack();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
            return;
          }

          if (pathname === "/api/remote/emergency" && req.method === "POST") {
            const isActive = Boolean(body.isActive);
            await this.trula.emergency(isActive);
            this.broadcast({ type: "emergency", isActive });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, isActive }));
            return;
          }

          if (pathname === "/api/remote/set-track" && req.method === "POST") {
            await this.trula.setTrack({
              orderId: body.orderId || null,
              trackId: body.trackId || null,
              playlistId: body.playlistId || null,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
            return;
          }

          if (pathname === "/api/remote/queue" && req.method === "GET") {
            const orders = await this.trula.getQueue(20);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ orders }));
            return;
          }

          if (pathname === "/api/remote/search" && req.method === "POST") {
            const query = body.query?.trim();
            if (!query) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Пустой запрос" }));
              return;
            }
            const result = await convertMusicUrl(query);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result || { error: "Не удалось найти трек" }));
            return;
          }
        } catch (actionErr) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: actionErr.message }));
          return;
        }
      }

      if (pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", clients: this.clients.size }));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    // Attach WebSocket server for instant real-time HUD and Remote updates
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      const parsedUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (parsedUrl.pathname === "/ws") {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on("connection", async (ws) => {
      this.clients.add(ws);
      console.log(`[HUD/Remote] Подключен новый клиент (всего: ${this.clients.size})`);

      // Immediately send current playing track and emergency state on connect
      try {
        const data = await this.trula.getHudData();
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: "init",
              ...data,
              isEmergency: this.trula.isEmergencyActive,
            })
          );
        }
      } catch (e) {
        console.warn("[HUD/Remote] Ошибка отправки init клиенту:", e.message);
      }

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`[HUD/Remote] Клиент отключился (осталось: ${this.clients.size})`);
      });

      ws.on("error", (err) => {
        console.warn("[HUD/Remote] Ошибка сокета клиента:", err.message);
        this.clients.delete(ws);
      });
    });

    this.httpServer.listen(this.port, this.host, () => {
      console.log(`[HUD] Виджет для OBS: http://${this.host}:${this.port}/hud`);
      console.log(`[Remote] Пульт для стримера: http://${this.host}:${this.port}/remote`);
    });

    // Start 1-second progress pulse when playing to keep all HUDs synced
    this.syncInterval = setInterval(() => {
      if (this.clients.size > 0 && this.trula.cachedNowPlaying) {
        const now = this.trula.cachedNowPlaying;
        if (now.state === "play" && typeof now.seek === "number") {
          now.seek += 1;
          this.broadcast({
            type: "progress",
            seek: Math.floor(now.seek),
            duration: Math.floor(now.endTime || now.track?.duration || 0),
          });
        }
      }
    }, 1000);
  }

  broadcast(messageObj) {
    if (this.clients.size === 0) return;
    const str = JSON.stringify(messageObj);
    for (const client of this.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(str);
      }
    }
  }

  async handleTrulaEvent(type, payload) {
    try {
      if (type === "setTrack") {
        const hudData = await this.trula.getHudData();
        this.broadcast({
          type: "track_change",
          ...hudData,
          isEmergency: this.trula.isEmergencyActive,
        });
      } else if (type === "playState") {
        const newState = payload?.state || "stop";
        if (this.trula.cachedNowPlaying) {
          this.trula.cachedNowPlaying.state = newState;
        }
        this.broadcast({ type: "state_change", state: newState });
      } else if (type === "emergency") {
        this.broadcast({ type: "emergency", isActive: payload?.isActive });
      } else if (type === "orderAdded") {
        this.broadcast({ type: "orderAdded", payload });
      }
    } catch (err) {
      console.warn("[HUD/Remote] Ошибка при обработке события Trula:", err.message);
    }
  }

  stop() {
    if (this.syncInterval) clearInterval(this.syncInterval);
    if (this.wss) this.wss.close();
    if (this.httpServer) this.httpServer.close();
  }
}
