
module.exports = {
    name: 'ping',
    aliases: ['بنق', 'سرعة'], // يمكنك تشغيله بـ .ping أو .بنق أو .سرعة
    execute: async ({ sock, msg, reply, from }) => {
        const start = Date.now();
        await reply('🏓 جاري فحص سرعة الخادم...');
        const end = Date.now();
        
        const text = `*⚡ سرعة الاستجابة:* ${end - start}ms\n*🤖 النظام:* TARZAN VIP`;
        await sock.sendMessage(from, { text: text }, { quoted: msg });
        
        // تفاعل النجاح
        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
    }
};
