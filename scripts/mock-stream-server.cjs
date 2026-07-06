const http = require("node:http");

const defaultHost = "127.0.0.1";
const defaultPort = 15911;
const defaultDelayMs = 450;
const responseChunks = ["MOCK-", "STREAM-", "DONE"];

function getArgValue(name, fallback) {
  const index = process.argv.indexOf(name);

  if (index < 0 || index + 1 >= process.argv.length) {
    return fallback;
  }

  return process.argv[index + 1];
}

function getNumberArg(name, fallback) {
  const value = Number(getArgValue(name, ""));

  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

const host = getArgValue("--host", defaultHost);
const port = getNumberArg("--port", defaultPort);
const delayMs = getNumberArg("--delay-ms", defaultDelayMs);

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value));
}

function sendOptions(response) {
  response.writeHead(204, {
    "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-version",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*"
  });
  response.end();
}

function sendSseChunk(response, chunk) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
}

function sendSseDone(response) {
  response.write("data: [DONE]\n\n");
  response.end();
}

function readRequest(_request) {
  // The mock intentionally ignores request bodies and headers so it never stores secrets.
}

function createServer() {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
      sendJson(response, 200, { data: [{ id: "mock-sse-model" }] });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/chat/completions") {
      readRequest(request);
      response.writeHead(200, {
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8"
      });

      let index = 0;
      const timer = setInterval(() => {
        if (index >= responseChunks.length) {
          clearInterval(timer);
          sendSseDone(response);
          return;
        }

        sendSseChunk(response, responseChunks[index]);
        index += 1;
      }, delayMs);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  });
}

const server = createServer();

server.listen(port, host, () => {
  process.stdout.write(`mock-stream-server listening http://${host}:${port}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
