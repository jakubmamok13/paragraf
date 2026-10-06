// Serves the stand-in model over HTTP like Ollama, for browser tests:
//   npx tsx packages/core/test/fake-ollama-server.ts http://localhost:4173
import http from "node:http";
import { FAKE_MODELS, fakeModelReply } from "./fake-model";

const allowed = process.argv[2] ?? "http://localhost:5173";
http
  .createServer((req, res) => {
    if (req.headers.origin === allowed) {
      res.setHeader("Access-Control-Allow-Origin", allowed);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.end();
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: FAKE_MODELS.map((name) => ({ name })) }));
    if (req.url === "/api/chat" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // A local model takes its time; so does this one, a little.
        setTimeout(() => res.end(JSON.stringify(fakeModelReply(JSON.parse(body)))), 150);
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  })
  .listen(11434, "127.0.0.1", () => console.log(`fake Ollama on :11434 for ${allowed}`));
