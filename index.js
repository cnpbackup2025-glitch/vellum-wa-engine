const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLOUDFLARE_BASE_URL = process.env.CLOUDFLARE_BASE_URL || "https://vellum0antigravity.pages.dev";
const AUTO_REPLY_ENABLED = process.env.AUTO_REPLY_ENABLED !== "false";

let sock = null;
let currentQR = null;
let isConnected = false;
let userPhone = null;

const sessionDir = path.join(__dirname, "auth_session");
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

// -----------------------------------------------------------------------------
// Message Debouncing Buffer (Combines rapid-fire messages from same contact)
// -----------------------------------------------------------------------------
const debounceTimers = new Map();
const messageBuffers = new Map();

async function processBufferedMessage(senderJid, senderName) {
  const messages = messageBuffers.get(senderJid) || [];
  messageBuffers.delete(senderJid);
  debounceTimers.delete(senderJid);

  if (messages.length === 0) return;
  const combinedText = messages.join("\n");
  console.log(`[WA] Received from ${senderName} (${senderJid}): ${combinedText}`);

  const phone = senderJid.split("@")[0];
  const title = senderName ? `${senderName} (${phone})` : phone;

  // 1. Sync conversation to Cloudflare D1
  try {
    await fetch(`${CLOUDFLARE_BASE_URL}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: senderJid,
        title: title,
        groupId: "whatsapp"
      })
    });

    // 2. Save incoming user message to D1
    await fetch(`${CLOUDFLARE_BASE_URL}/api/conversations/${encodeURIComponent(senderJid)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "user",
        content: combinedText
      })
    });
  } catch (err) {
    console.error("[WA -> Cloudflare D1 Error]:", err.message);
  }

  // 3. Auto-Reply via Cloudflare Edge AI (DeepSeek / Gemini with AI Gateway Caching)
  if (AUTO_REPLY_ENABLED && sock) {
    try {
      console.log(`[WA] Requesting AI answer for ${senderJid}...`);
      const aiRes = await fetch(`${CLOUDFLARE_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
          messages: [
            {
              role: "system",
              content: "Kamu adalah asisten WhatsApp cerdas yang profesional, ramah, dan ringkas. Jawablah pesan pelanggan secara informatif, sopan, langsung ke inti masalah dalam bahasa Indonesia."
            },
            {
              role: "user",
              content: combinedText
            }
          ],
          stream: false
        })
      });

      if (aiRes.ok) {
        const data = await aiRes.json();
        let reply = data.choices?.[0]?.message?.content || "";
        // Strip think tags if any from DeepSeek R1
        reply = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

        if (reply) {
          console.log(`[WA] Sending AI reply to ${senderJid}: ${reply.slice(0, 60)}...`);
          await sock.sendMessage(senderJid, { text: reply });

          // Save assistant message to D1
          await fetch(`${CLOUDFLARE_BASE_URL}/api/conversations/${encodeURIComponent(senderJid)}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              role: "assistant",
              content: reply,
              model: "DeepSeek R1 Edge"
            })
          });
        }
      }
    } catch (aiErr) {
      console.error("[WA AI Generation Error]:", aiErr.message);
    }
  }
}

// -----------------------------------------------------------------------------
// WhatsApp Socket Initialization
// -----------------------------------------------------------------------------
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WA] Using Baileys v${version.join(".")}, isLatest: ${isLatest}`);

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
    browser: ["Vellum Assistant", "Chrome", "1.0.0"],
    syncFullHistory: false
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log("[WA] New QR code generated. Visit /qr to scan.");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        `[WA] Connection closed due to: ${lastDisconnect?.error?.message}. Reconnecting: ${shouldReconnect}`
      );
      isConnected = false;
      currentQR = null;
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      }
    } else if (connection === "open") {
      isConnected = true;
      currentQR = null;
      userPhone = sock.user?.id ? sock.user.id.split(":")[0] : "Connected";
      console.log(`[WA] Successfully connected as ${userPhone}!`);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@broadcast")) continue;

      const body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";

      if (!body.trim()) continue;

      const senderName = msg.pushName || "";
      if (!messageBuffers.has(jid)) {
        messageBuffers.set(jid, []);
      }
      messageBuffers.get(jid).push(body.trim());

      if (debounceTimers.has(jid)) {
        clearTimeout(debounceTimers.get(jid));
      }

      debounceTimers.set(
        jid,
        setTimeout(() => processBufferedMessage(jid, senderName), 3500)
      );
    }
  });
}

// -----------------------------------------------------------------------------
// Web Endpoints (Keep-Alive, QR, Status, Send)
// -----------------------------------------------------------------------------

// 1. Keep-Alive Ping (Called by Cloudflare Cron every 10 mins)
app.get(["/", "/ping"], (req, res) => {
  res.json({
    status: "alive",
    engine: "Vellum-WA Cloud Engine",
    connected: isConnected,
    phone: userPhone,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// 2. Status Endpoint
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    phone: userPhone,
    qrAvailable: Boolean(currentQR)
  });
});

// 3. QR Code View (Auto-refreshing visual page)
app.get("/qr", async (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Vellum WA - Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: white; text-align: center; }
          .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; border: 1px solid #334155; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
          .badge { display: inline-block; padding: 0.5rem 1rem; background: #059669; color: #ecfdf5; border-radius: 9999px; font-weight: bold; margin-bottom: 1rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">ONLINE & CONNECTED</div>
          <h2>WhatsApp Terhubung!</h2>
          <p style="color: #94a3b8;">Nomor: <b>${userPhone}</b></p>
          <p style="font-size: 0.875rem; color: #64748b;">Engine aktif 24/7 dan terhubung ke Cloudflare D1 & AI Gateway.</p>
        </div>
      </body>
      </html>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Vellum WA - Loading</title>
        <meta http-equiv="refresh" content="3">
        <style>
          body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: white; text-align: center; }
        </style>
      </head>
      <body>
        <div>
          <h2>Menyiapkan QR Code...</h2>
          <p style="color: #94a3b8;">Sedang menghubungkan ke server WhatsApp. Halaman akan refresh otomatis.</p>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 320, margin: 2 });
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Scan QR WhatsApp - Vellum</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="15">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f172a; color: white; }
          .card { background: #1e293b; padding: 2rem; border-radius: 1.25rem; border: 1px solid #334155; text-align: center; max-width: 380px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
          .qr-box { background: white; padding: 1rem; border-radius: 0.75rem; display: inline-block; margin: 1.25rem 0; }
          .qr-box img { display: block; max-width: 100%; height: auto; }
          .steps { text-align: left; font-size: 0.85rem; color: #94a3b8; line-height: 1.5; margin-top: 1rem; padding-left: 1.2rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2 style="margin:0 0 0.5rem 0;">Tautkan WhatsApp</h2>
          <p style="margin:0; font-size: 0.875rem; color: #94a3b8;">Scan QR code ini untuk mengaktifkan Vellum 24/7</p>
          <div class="qr-box">
            <img src="${qrDataUrl}" alt="QR Code" />
          </div>
          <ol class="steps">
            <li>Buka WhatsApp di HP Anda</li>
            <li>Ketuk <b>Perangkat Tertaut</b> (Linked Devices)</li>
            <li>Arahkan kamera ke QR Code di atas</li>
          </ol>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Gagal membuat gambar QR: " + err.message);
  }
});

// 4. API to send message manually from Vellum Dashboard
app.post("/api/send", async (req, res) => {
  const { to, message } = req.body;
  if (!sock || !isConnected) {
    return res.status(503).json({ error: "WhatsApp is not connected" });
  }
  if (!to || !message) {
    return res.status(400).json({ error: "Missing 'to' or 'message'" });
  }

  let formattedJid = to.replace(/[^0-9]/g, "");
  if (!formattedJid.includes("@")) {
    formattedJid += "@s.whatsapp.net";
  }

  try {
    await sock.sendMessage(formattedJid, { text: message });
    res.json({ success: true, to: formattedJid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Vellum-WA Engine] Running on port ${PORT}`);
  connectToWhatsApp().catch((err) => console.error("[WA Init Error]:", err));
});
