// WhatsApp Anti-Delete Bot (Replit version)
// Lengkap: anti hapus, auto reboot, admin control, ignore call, single tick
// By Aditya Refandi Edition

const fs = require("fs");
const path = require("path");
const express = require("express");
const mime = require("mime-types");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers
} = require("@whiskeysockets/baileys");

// ===== CONFIG =====
const ADMIN_NUMBERS = ["6282244877433"]; // nomormu sudah diset
const DATA_DIR = path.resolve("./data");
const CFG = {
  AUTH_DIR: path.join(DATA_DIR, "auth"),
  BASE_DIR: path.join(DATA_DIR, "storage"),
  MEDIA_DIR: path.join(DATA_DIR, "storage/media"),
  HTML_DIR: path.join(DATA_DIR, "storage/html"),
  DB_FILE: path.join(DATA_DIR, "storage/db.json"),
  HTML_TTL_MS: 2 * 60 * 60 * 1000,
  HTML_SCAN_MS: 5 * 60 * 1000,
  PORT: process.env.PORT || 3000,
  SERVE_WEB: true
};
[CFG.AUTH_DIR, CFG.BASE_DIR, CFG.MEDIA_DIR, CFG.HTML_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const logger = pino({ level: "info" });

// ==== ADMIN & STATUS ====
let botActive = true;
function isAdmin(jid) {
  return ADMIN_NUMBERS.some(num => jid.includes(num));
}
async function handleAdminCommand(sock, jid, text) {
  const cmd = text.trim().toLowerCase();
  if (cmd === "/on") {
    botActive = true;
    await sock.sendMessage(jid, { text: "✅ Bot diaktifkan kembali." });
  } else if (cmd === "/off") {
    botActive = false;
    await sock.sendMessage(jid, { text: "⏸️ Bot di-nonaktifkan sementara." });
  } else if (cmd === "/status") {
    const msg = botActive ? "🟢 Bot aktif" : "🔴 Bot idle (tidak aktif sementara)";
    await sock.sendMessage(jid, { text: msg });
  }
}

function escHTML(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function safeName(s){return String(s||"").replace(/[^a-zA-Z0-9._-]+/g,"_").slice(0,80)}
function tsForFile(d=new Date()){const p=n=>String(n).padStart(2,"0");return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+"-"+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())}
function nowTS(){return new Date().toISOString()}

// ==== EXPRESS SERVER ====
let app = express();
app.use("/media", express.static(CFG.MEDIA_DIR));
app.use("/html", express.static(CFG.HTML_DIR));
let currentQR = null;
app.get("/", (req, res) => {
  const files = fs.readdirSync(CFG.HTML_DIR).filter(f=>f.endsWith(".html"));
  const list = files.map(f=>`<li><a href="/html/${encodeURIComponent(f)}">${f}</a></li>`).join("");
  res.send(`<!doctype html><meta charset="utf-8"><title>WA Logs</title>
  <h2>WA Chat Logs (TTL 2 jam)</h2>
  <p><a href="/qr" target="_blank">Lihat QR (jika belum login)</a></p>
  <ul>${list}</ul>`);
});
app.get("/qr", async (req, res) => {
  if (!currentQR) return res.send("✅ Sudah login atau tidak ada QR saat ini.");
  const png = await QRCode.toBuffer(currentQR, { margin: 1, width: 300 });
  res.setHeader("Content-Type", "image/png");
  res.end(png);
});
app.listen(CFG.PORT, () => logger.info("Server on port " + CFG.PORT));

// ==== DB ====
function loadDB(){try{return JSON.parse(fs.readFileSync(CFG.DB_FILE,"utf8"))}catch{return{chats:{}}}}
function saveDB(){fs.writeFileSync(CFG.DB_FILE,JSON.stringify(DB,null,2))}
const DB=loadDB();
function chatSlot(jid){if(!DB.chats[jid])DB.chats[jid]={messages:{},order:[]};return DB.chats[jid];}
function trimChat(jid,max=5000){const cs=chatSlot(jid);while(cs.order.length>max){const id=cs.order.shift();delete cs.messages[id];}}

// ==== SWEEP OLD HTML ====
function sweepOldHtml(){
  const now=Date.now();
  for(const f of fs.readdirSync(CFG.HTML_DIR)){
    if(!f.endsWith(".html"))continue;
    const full=path.join(CFG.HTML_DIR,f);
    const st=fs.statSync(full);
    if(now-st.mtimeMs>CFG.HTML_TTL_MS){fs.unlinkSync(full);logger.info("HTML expired:"+f);}
  }
}
setInterval(sweepOldHtml,CFG.HTML_SCAN_MS);

// ==== MAIN ====
(async()=>{
  const {state,saveCreds}=await useMultiFileAuthState(CFG.AUTH_DIR);
  const {version}=await fetchLatestBaileysVersion();
  const sock=makeWASocket({
    version,logger,auth:state,browser:Browsers.macOS("Chrome"),printQRInTerminal:false
  });

  // abaikan panggilan masuk
  sock.ev.on("call",calls=>{
    for(const c of calls){logger.info("Panggilan diabaikan dari:",c.from);}
  });

  // koneksi update + QR
  sock.ev.on("connection.update",(u)=>{
    const {connection,qr}=u;
    if(qr){currentQR=qr;qrcodeTerminal.generate(qr,{small:true});}
    if(connection==="open"){currentQR=null;notifyAdmins(sock,"✅ Bot online kembali.");}
  });
  sock.ev.on("creds.update",saveCreds);

  // single tick only
  sock.sendReceiptAck=async()=>{};

  // pesan masuk
  sock.ev.on("messages.upsert",async({messages})=>{
    for(const m of messages){
      if(!m.message)continue;
      const jid=m.key.remoteJid;
      const txt=extractText(m);
      if(isAdmin(jid)&&txt.startsWith("/"))return handleAdminCommand(sock,jid,txt);
      if(!botActive)return;
      const t=(m.messageTimestamp||Date.now()/1000)*1000;
      const info={id:m.key.id,jid,fromMe:!!m.key.fromMe,pushName:m.pushName||"",timestamp:t,
        type:detectType(m),text:txt,deleted:false,mediaPath:null,mimetype:null};
      const mediaMeta=getMediaMeta(m);
      if(mediaMeta){
        const buffer=await downloadMediaMessage(m,"buffer",{}, {logger});
        const ext=mime.extension(mediaMeta.mimetype)||"bin";
        const fname=`${tsForFile(new Date(t))}_${safeName(jid)}.${ext}`;
        const full=path.join(CFG.MEDIA_DIR,fname);
        fs.writeFileSync(full,buffer);
        info.mediaPath="media/"+fname;
        info.mimetype=mediaMeta.mimetype;
      }
      const cs=chatSlot(jid);cs.messages[info.id]=info;cs.order.push(info.id);trimChat(jid);saveDB();
      writeHTML(jid);
    }
  });

  // revoke
  sock.ev.on("messages.update",async(upd)=>{
    for(const u of upd){
      if(u.update?.message?.protocolMessage)handleRevoke(u.update);
    }
  });

  function detectType(m){const msg=m.message||{};if(msg.conversation)return"text";
    if(msg.extendedTextMessage)return"text";if(msg.imageMessage)return"image";
    if(msg.videoMessage)return"video";if(msg.audioMessage)return"audio";
    if(msg.stickerMessage)return"sticker";if(msg.documentMessage)return"document";
    return"unknown";}
  function extractText(m){const msg=m.message||{};return msg.conversation||msg.extendedTextMessage?.text||msg.imageMessage?.caption||msg.videoMessage?.caption||"";}
  function getMediaMeta(m){const msg=m.message||{};return msg.imageMessage||msg.videoMessage||msg.audioMessage||msg.stickerMessage||msg.documentMessage||null;}

  async function handleRevoke(m){
    const ref=m.message?.protocolMessage?.key;if(!ref)return;
    const jid=ref.remoteJid,id=ref.id;const cs=chatSlot(jid);
    if(cs.messages[id])cs.messages[id].deleted=true;
    else cs.messages[id]={id,jid,fromMe:false,pushName:"",timestamp:Date.now(),type:"unknown",text:"[deleted]",deleted:true};
    saveDB();writeHTML(jid);
  }

  function writeHTML(jid){
    const cs=chatSlot(jid);
    const msgs=cs.order.map(id=>cs.messages[id]);
    const html=msgs.map(m=>{
      const time=new Date(m.timestamp).toLocaleString();
      const who=m.fromMe?"Me":(m.pushName||"Sender");
      const del=m.deleted?`<span style="color:red">[deleted]</span>`:"";
      const text=m.text?`<p>${escHTML(m.text)}</p>`:"";
      const media=m.mediaPath?`<a href="/${m.mediaPath}" target="_blank">📎 ${path.basename(m.mediaPath)}</a>`:"";
      return `<div><b>${who}</b> - ${time} ${del}${text}${media}</div>`;
    }).join("<hr>");
    fs.writeFileSync(path.join(CFG.HTML_DIR,`${tsForFile()}_${safeName(jid)}.html`),
      `<!doctype html><meta charset="utf-8"><title>${jid}</title>${html}`);
  }

  async function notifyAdmins(sock,msg){
    for(const a of ADMIN_NUMBERS){
      const jid=a+"@s.whatsapp.net";
      try{await sock.sendMessage(jid,{text:msg});}catch{}
    }
  }

  process.on("uncaughtException",async(e)=>{
    logger.error(e);await notifyAdmins(sock,"⚠️ Bot crash, restart otomatis...");process.exit(1);
  });
})();
