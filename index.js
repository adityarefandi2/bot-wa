const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 8080;
let sock;
let qrCodeData = "";
let botActive = true;
const adminNumbers = ["6282244877433"]; // ganti nomormu di sini

// pastikan folder ada
["./data", "./data/auth", "./data/media", "./data/html"].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./data/auth");
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      console.log("📱 QR diperbarui, buka /qr untuk scan");
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconnect...");
        startBot();
      } else console.log("❌ Logged out, scan ulang QR!");
    } else if (connection === "open") {
      console.log("✅ Bot tersambung ke WhatsApp");
      qrCodeData = "";
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (!botActive) return;
    const msg = m.messages[0];
    if (!msg.message) return;
    const from = msg.key.remoteJid;
    const isAdmin = adminNumbers.includes(from.split("@")[0]);

    // Simpan pesan sebagai HTML
    const htmlPath = `./data/html/${Date.now()}.html`;
    fs.writeFileSync(htmlPath, `<pre>${JSON.stringify(msg, null, 2)}</pre>`);
    setTimeout(() => {
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
    }, 2 * 60 * 60 * 1000);

    // Simpan media
    if (msg.message.imageMessage) {
      const buffer = await sock.downloadMediaMessage(msg);
      const fileName = `./data/media/${Date.now()}.jpg`;
      fs.writeFileSync(fileName, buffer);
    }

    // Command admin
    if (isAdmin && msg.message.conversation) {
      const body = msg.message.conversation.trim().toLowerCase();
      if (body === "/off") {
        botActive = false;
        await sock.sendMessage(from, { text: "🤖 Bot idle (nonaktif sementara)" });
      } else if (body === "/on") {
        botActive = true;
        await sock.sendMessage(from, { text: "✅ Bot aktif kembali" });
      }
    }
  });

  // Abaikan panggilan
  sock.ev.on("call", (call) => console.log("📵 Panggilan diabaikan:", call.from));

  sock.ev.on("creds.update", saveCreds);
}

// endpoint web
app.get("/", (_, res) => res.send("✅ WA Anti Delete Bot Aktif!"));
app.get("/qr", (_, res) => {
  if (!qrCodeData) return res.send("✅ Sudah login / tidak ada QR saat ini");
  const img = Buffer.from(qrCodeData.split(",")[1], "base64");
  res.writeHead(200, { "Content-Type": "image/png" });
  res.end(img);
});

app.listen(PORT, () => {
  console.log("🚀 Server aktif di port", PORT);
  startBot();
});

// jaga Railway tetap hidup
setInterval(() => {}, 60 * 1000);
