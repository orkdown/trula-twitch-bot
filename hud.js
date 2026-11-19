import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = parsedUrl.pathname;

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

      if (pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", clients: this.clients.size }));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    // Attach WebSocket server for instant real-time HUD updates
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
      console.log(`[HUD] Подключен новый клиент OBS Browser Source (всего: ${this.clients.size})`);

      // Immediately send current playing track on connect
      try {
        const data = await this.trula.getHudData();
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "init", ...data }));
        }
      } catch (e) {
        console.warn("[HUD] Ошибка отправки init клиенту:", e.message);
      }

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`[HUD] Клиент отключился (осталось: ${this.clients.size})`);
      });

      ws.on("error", (err) => {
        console.warn("[HUD] Ошибка сокета клиента:", err.message);
        this.clients.delete(ws);
      });
    });

    this.httpServer.listen(this.port, this.host, () => {
      console.log(`[HUD] Виджет для OBS запущен на http://${this.host}:${this.port}/hud`);
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
        this.broadcast({ type: "track_change", ...hudData });
      } else if (type === "playState") {
        this.broadcast({ type: "state_change", state: payload?.state || "stop" });
      }
    } catch (err) {
      console.warn("[HUD] Ошибка при обработке события Trula:", err.message);
    }
  }

  stop() {
    if (this.syncInterval) clearInterval(this.syncInterval);
    if (this.wss) this.wss.close();
    if (this.httpServer) this.httpServer.close();
  }
}
