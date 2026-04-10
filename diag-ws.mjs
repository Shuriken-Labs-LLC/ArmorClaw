import { readFileSync } from "fs";
import { homedir } from "os";

const config = JSON.parse(readFileSync(homedir() + "/.openclaw/openclaw.json", "utf8"));
const token = config?.gateway?.auth?.token;

if (!token) {
  console.log("FATAL: no token found in openclaw.json");
  process.exit(1);
}

console.log("Token found, first 8:", token.slice(0, 8));
console.log("Connecting to ws://127.0.0.1:18789 ...");

const ws = new WebSocket("ws://127.0.0.1:18789");

const timeout = setTimeout(() => {
  console.log("TIMEOUT: no response after 5 seconds");
  ws.close();
  process.exit(1);
}, 5000);

ws.addEventListener("open", () => {
  console.log("WebSocket OPEN");
});

ws.addEventListener("message", (evt) => {
  const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
  console.log("RAW MESSAGE:", raw);

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    console.log("Failed to parse message as JSON:", e.message);
    return;
  }

  if (msg.type === "event" && msg.event === "connect.challenge") {
    console.log("Got connect.challenge, sending connect request...");
    const connectReq = {
      type: "req",
      id: "diag-1",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "gateway-client",
          displayName: "Diagnostic",
          version: "0.1.0",
          platform: "node",
          mode: "backend",
        },
        auth: { token },
      },
    };
    console.log("SENDING:", JSON.stringify(connectReq, null, 2));
    ws.send(JSON.stringify(connectReq));
  } else if (msg.id === "diag-1") {
    console.log("CONNECT RESPONSE:", JSON.stringify(msg, null, 2));
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  } else {
    console.log("OTHER MESSAGE:", JSON.stringify(msg, null, 2));
  }
});

ws.addEventListener("error", (err) => {
  console.log("WebSocket ERROR:", err.message ?? err);
  clearTimeout(timeout);
  process.exit(1);
});

ws.addEventListener("close", (evt) => {
  console.log("WebSocket CLOSED, code:", evt.code, "reason:", evt.reason);
});
