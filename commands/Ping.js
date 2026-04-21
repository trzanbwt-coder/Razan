const crypto = require('crypto');

module.exports = {
    name: 'اتصال',
    aliases: ['مكالمة', 'ازعاج', 'call'],
    execute: async ({ sock, args, reply, isFromMe }) => {
        
        // 🛡️ حماية VIP: هذا الأمر خطير، لذلك لن يعمل إلا إذا استخدمته أنت (صاحب الجلسة)
        if (!isFromMe) {
            return reply('❌ *هـذا الأمـر مـخـصـص لـمـالـك الـبـوت (VIP) فـقـط.*');
        }

        // 📝 التحقق من كتابة الأمر بشكل صحيح
        if (args.length < 2) {
            return reply('⚠️ *طـريـقـة الاسـتـخـدام:*\n.اتصال [الرقم] [عدد المكالمات]\n\n*مـثـال:*\n.اتصال 966500000000 10');
        }

        // 🔢 تنظيف الرقم من أي مسافات أو علامات
        const targetNumber = args[0].replace(/[^0-9]/g, '');
        const count = parseInt(args[1]);

        if (!targetNumber) return reply('❌ *الـرقـم غـيـر صـحـيـح.*');
        if (isNaN(count) || count <= 0) return reply('❌ *عـدد الـمـكـالـمـات غـيـر صـحـيـح.*');
        
        // 🛡️ حماية لرقمك من حظر واتساب بسبب السبام
        if (count > 50) return reply('⚠️ *حـمـايـة للـبـوت: الـحـد الأقـصـى الـمـسـمـوح بـه هـو 50 مـكـالـمـة فـي الـمـرة الـواحـدة.*');

        const targetJid = `${targetNumber}@s.whatsapp.net`;

        // 📢 إشعار بدء العملية
        await reply(`🔥 *[ نـظـام هـجـوم الـمـكـالـمـات VIP ]* 🔥\n\n🎯 *الـهـدف:* +${targetNumber}\n📞 *الـعـدد:* ${count} مكالمة\n⏱️ *الـمـدة:* رنة كل ثانية\n\n*⏳ جـاري الـتـنـفـيـذ...*`);

        let successCount = 0;

        for (let i = 0; i < count; i++) {
            try {
                // توليد معرف مكالمة عشوائي (Call ID) لاختراق بروتوكول واتساب
                const callId = crypto.randomBytes(16).toString('hex').substring(0, 16);
                const callerId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

                // 1. إرسال رنة (Call Offer)
                await sock.query({
                    tag: 'call',
                    attrs: { to: targetJid },
                    content: [{
                        tag: 'offer',
                        attrs: {
                            'call-id': callId,
                            'call-creator': callerId
                        },
                        content: [{ tag: 'audio', attrs: {} }]
                    }]
                });

                // انتظار ثانية واحدة (جاري الرنين عند الضحية)
                await new Promise(resolve => setTimeout(resolve, 1000));

                // 2. فصل المكالمة (Call Cancel - لعمل Missed Call)
                await sock.query({
                    tag: 'call',
                    attrs: { to: targetJid },
                    content: [{
                        tag: 'cancel',
                        attrs: {
                            'call-id': callId,
                            'call-creator': callerId
                        }
                    }]
                });

                successCount++;
                
                // استراحة نصف ثانية قبل إرسال المكالمة التالية لتجنب ضغط الخوادم
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (error) {
                console.error('❌ خطأ في إرسال المكالمة:', error.message);
            }
        }

        // 🏁 إشعار الانتهاء
        await reply(`✅ *[ تـم انـتـهـاء الـهـجـوم ]*\n\n📞 *تم تنفيذ:* ${successCount} مكالمة فائتة (Missed Calls)\n🎯 *الضحية:* +${targetNumber}`);
    }
};
