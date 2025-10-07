import express from "express";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import P from "pino";
import fs from "fs";
import path from "path";
import qrcode from "qrcode";

const app = express();
const PORT = process.env.PORT || 8080;
let sock;
let qrCodeData = "";
let botActive = true;
const adminNumbers = ["6282244877433"]; // <== GANTI DENGAN NOMOR ADMIN (tanpa +)

const ensureDirs = () => {
  ["./data/media", "./data/html"].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
};
ensureDirs();

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./data/auth");
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" })
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      console.log("QR updated!");
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...");
        startBot();
      }
    } else if (connection === "open") {
      console.log("✅ Bot connected");
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
    setTimeout(() => fs.unlinkSync(htmlPath), 2 * 60 * 60 * 1000);

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

  sock.ev.on("call", async (call) => {
    console.log("Ignored incoming call:", call.from);
  });

  sock.ev.on("creds.update", saveCreds);
}

app.get("/", (req, res) => res.send("✅ WA Anti Delete Bot Aktif!"));
app.get("/qr", (req, res) => {
  if (!qrCodeData) return res.send("✅ Sudah login / tidak ada QR saat ini");
  const img = Buffer.from(qrCodeData.split(",")[1], "base64");
  res.writeHead(200, { "Content-Type": "image/png" });
  res.end(img);
});

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  startBot();
});

setInterval(() => {}, 60 * 1000);
