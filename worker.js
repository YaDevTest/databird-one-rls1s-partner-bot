export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. АПИ для проверки статуса партнера с сайта (чтобы показать скидку)
    if (url.pathname === '/api/partner' && request.method === 'GET') {
      const partnerId = url.searchParams.get('p');
      if (partnerId) {
        const dataStr = await env.PARTNERS_KV.get('partner_' + partnerId);
        if (dataStr) {
          const data = parsePartnerData(dataStr);
          return new Response(JSON.stringify({
            exists: true,
            discount: data.discount || 0,
            whatsapp: data.substitute ? data.whatsapp : null
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*' // CORS для запросов с сайта
            }
          });
        }
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // 2. АПИ для уведомлений при клике на WhatsApp
    if (url.pathname === '/api/notify' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch(e){}
      
      const partnerId = body.p;
      if (partnerId) {
        const dataStr = await env.PARTNERS_KV.get('partner_' + partnerId);
        if (dataStr) {
          const data = parsePartnerData(dataStr);
          if (data.notify && data.chat_id) {
            // Отправляем уведомление партнеру в Телеграм
            await sendTelegram(env.BOT_TOKEN, data.chat_id, `🔔 <b>У вас новый лид!</b>\nПользователь только что кликнул по кнопке перехода в WhatsApp по вашему партнерскому коду (<b>${partnerId}</b>). Ожидайте сообщения.`);
          }
        }
      }
      return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // 3. Обработка вебхуков от Telegram
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        await handleTelegram(update, env);
      } catch (e) {
        console.error(e);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// Функция парсинга данных партнера (с поддержкой старого формата, где просто лежал chat_id)
function parsePartnerData(rawData) {
  try {
    return JSON.parse(rawData);
  } catch (e) {
    // Старый формат: строка с chat_id
    return {
      chat_id: rawData,
      notify: true,
      substitute: false,
      whatsapp: null
    };
  }
}

async function handleTelegram(update, env) {
  const adminId = env.ADMIN_CHAT_ID;

  // Обработка текстовых сообщений
  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    if (text.startsWith('/discount')) {
      if (chatId.toString() !== adminId.toString()) return;
      const parts = text.split(' ');
      if (parts.length === 2) {
        const disc = parseInt(parts[1]);
        if (disc === 0) {
          await env.PARTNERS_KV.delete('partner_main');
          await sendTelegram(env.BOT_TOKEN, chatId, 'Глобальная скидка (на основную ссылку) отключена.');
        } else {
          await env.PARTNERS_KV.put('partner_main', JSON.stringify({ discount: disc }));
          await sendTelegram(env.BOT_TOKEN, chatId, `Глобальная скидка установлена на ${disc}%.`);
        }
      } else {
        await sendTelegram(env.BOT_TOKEN, chatId, 'Используйте формат: /discount 50 (или /discount 0 для отключения)');
      }
      return;
    }
    
    if (text === '/partners') {
      if (chatId.toString() !== adminId.toString()) return;
      const list = await env.PARTNERS_KV.list({prefix: 'partner_'});
      if (list.keys.length === 0) {
        await sendTelegram(env.BOT_TOKEN, chatId, 'Список партнеров пуст.');
        return;
      }
      
      for (const key of list.keys) {
        const code = key.name.replace('partner_', '');
        if (code === 'main') continue;
        
        const val = await env.PARTNERS_KV.get(key.name);
        const data = parsePartnerData(val);
        
        const msg = `Партнер: <b>${code}</b>\nУведомления: ${data.notify ? 'Да' : 'Нет'}\nПереадресация: ${data.substitute ? 'Да' : 'Нет'}\nWhatsApp: ${data.whatsapp || 'нет'}\nСкидка: ${data.discount ? data.discount + '%' : 'нет'}`;
        const buttons = [[{ text: `❌ Отозвать ${code}`, callback_data: `revoke_${code}` }]];
        
        await sendTelegram(env.BOT_TOKEN, chatId, msg, { inline_keyboard: buttons });
      }
      return;
    }

    if (text === '/start') {
      await sendTelegram(env.BOT_TOKEN, chatId, '👋 Добро пожаловать! Введите код 4-значный код партнера (например, 0001), номер телефона для подмены и размер скидки в процентах.');
      return;
    }

    const parts = text.split(/\s+/);
    
    if (parts.length > 0 && /^[a-zA-Z0-9]{1,10}$/.test(parts[0])) {
      const code = parts[0];
      let phone = null;
      let discount = null;

      if (parts.length === 2) {
        if (parts[1].includes('%') || parts[1].length <= 3) discount = parseInt(parts[1].replace('%', ''));
        else phone = parts[1];
      } else if (parts.length >= 3) {
        let last = parts[parts.length - 1];
        if (last.includes('%') || last.length <= 3) {
          discount = parseInt(last.replace('%', ''));
          phone = parts.slice(1, -1).join('');
        } else {
          phone = parts.slice(1).join('');
        }
      }

      if (phone) {
        phone = phone.replace(/\D/g, '');
        if (phone.length > 11) phone = phone.slice(-11);
        if (phone.length === 11 && phone.startsWith('8')) {
          phone = '7' + phone.substring(1);
        }
      }

      await sendTelegram(env.BOT_TOKEN, chatId, `⏳ Заявка на партнерский код <b>${code}</b> отправлена администратору. Пожалуйста, ожидайте.`);
      
      let adminText = `🚨 <b>Новая заявка на партнерство!</b>\nПользователь ID: <code>${chatId}</code>\nЖелаемый код: <b>${code}</b>` + (phone ? `\nWhatsApp: <b>${phone}</b>` : `\n<i>Без подмены WhatsApp (официальный номер)</i>`);
      
      const existing = await env.PARTNERS_KV.get('partner_' + code);
      if (existing) {
        const existingData = parsePartnerData(existing);
        if (existingData.chat_id.toString() !== chatId.toString()) {
          adminText += '\n\n⚠️ <b>ВНИМАНИЕ:</b> Этот код уже занят другим Telegram ID! Будьте осторожны.';
        } else {
          adminText += '\n\nℹ️ <i>(Это обновление данных для существующего партнера)</i>';
        }
      }
      
      if (discount) adminText += `\nСкидка: <b>${discount}%</b>`;

      let buttons = [
        [{ text: '✅ Только уведомления', callback_data: `app_n_${code}_${chatId}_none_${discount || 0}` }]
      ];

      if (phone) {
        buttons.push([{ text: '✅ Только переадресация', callback_data: `app_s_${code}_${chatId}_${phone}_${discount || 0}` }]);
        buttons.push([{ text: '✅ Переадресация + Уведомления', callback_data: `app_b_${code}_${chatId}_${phone}_${discount || 0}` }]);
      }

      buttons.push([{ text: '❌ Отклонить', callback_data: `rej_${code}_${chatId}` }]);

      const keyboard = { inline_keyboard: buttons };
      await sendTelegram(env.BOT_TOKEN, adminId, adminText, keyboard);
      return;
    }

    await sendTelegram(env.BOT_TOKEN, chatId, 'Неизвестная команда. Введите партнерский код или /start.');
  }

  // Обработка нажатий на инлайн-кнопки
  if (update.callback_query) {
    const callback = update.callback_query;
    const data = callback.data; 
    const adminChatId = callback.message.chat.id;

    // Убедимся, что нажал именно админ
    if (adminChatId.toString() !== adminId) return;

    if (data.startsWith('app_')) {
      const parts = data.split('_');
      const mode = parts[1]; // n, s, b
      const partnerCode = parts[2];
      const partnerChatId = parts[3];
      const phone = parts[4] === 'none' ? null : parts[4];
      const discount = parts[5] ? parseInt(parts[5]) : null;

      let partnerData = {
        chat_id: partnerChatId,
        whatsapp: phone,
        notify: mode === 'n' || mode === 'b',
        substitute: mode === 's' || mode === 'b',
        discount: discount > 0 ? discount : null
      };

      // Запись в KV базу
      await env.PARTNERS_KV.put('partner_' + partnerCode, JSON.stringify(partnerData));

      let modeText = '';
      if (mode === 'n') modeText = 'Только уведомления';
      if (mode === 's') modeText = 'Только переадресация на ваш номер';
      if (mode === 'b') modeText = 'Переадресация + Уведомления';

      await sendTelegram(env.BOT_TOKEN, adminChatId, `Одобрено (${modeText}): код <b>${partnerCode}</b> для ID ${partnerChatId}`);
      
      let clientMsg = `🎉 <b>Ваша заявка одобрена!</b>\nКод: <b>${partnerCode}</b>\nРежим: <b>${modeText}</b>`;
      if (phone) clientMsg += `\nВаш WhatsApp для лидов: ${phone}`;
      await sendTelegram(env.BOT_TOKEN, partnerChatId, clientMsg);
    } 

    else if (data.startsWith('revoke_')) {
      const code = data.split('_')[1];
      const val = await env.PARTNERS_KV.get('partner_' + code);
      if (val) {
        const pData = parsePartnerData(val);
        await env.PARTNERS_KV.delete('partner_' + code);
        await sendTelegram(env.BOT_TOKEN, adminChatId, `Партнер <b>${code}</b> отозван и удален из базы.`);
        if (pData.chat_id) {
            await sendTelegram(env.BOT_TOKEN, pData.chat_id, `Уважаемый партнер! Ваше партнерство (код <b>${code}</b>) было отозвано. Скидки и переадресация для ваших клиентов отключены.`);
        }
      } else {
        await sendTelegram(env.BOT_TOKEN, adminChatId, `Партнер ${code} не найден.`);
      }
    }
    else if (data.startsWith('rej_')) {
      const parts = data.split('_');
      const partnerCode = parts[1];
      const partnerChatId = parts[2];

      await sendTelegram(env.BOT_TOKEN, adminChatId, `Вы отклонили заявку на код <b>${partnerCode}</b> от ID ${partnerChatId}`);
      await sendTelegram(env.BOT_TOKEN, partnerChatId, `К сожалению, администратор отклонил вашу заявку на код <b>${partnerCode}</b>.`);
    }
  }
}

async function sendTelegram(token, chat_id, text, reply_markup = null) {
  const payload = { chat_id: chat_id, text: text, parse_mode: 'HTML' };
  if (reply_markup) payload.reply_markup = reply_markup;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}
