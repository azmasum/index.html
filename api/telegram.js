const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

function affLink(url, platform, userId) {
  try {
    const u = new URL(url)
    u.searchParams.set('sub_aff_id', process.env.DARAZ_AFF_ID || '')
    u.searchParams.set('sub_id1', 'txn_' + Date.now())
    u.searchParams.set('sub_id2', platform)
    u.searchParams.set('sub_id3', 'organic')
    u.searchParams.set('sub_id4', String(userId))
    u.searchParams.set('sub_id5', new Date().toISOString().split('T')[0])
    return u.toString()
  } catch (e) { return url }
}

function discountInfo(p) {
  const o = parseFloat(p.original_price) || 0
  const c = parseFloat(p.price) || 0
  if (o > c) {
    const saved = o - c
    const pct = Math.round((saved / o) * 100)
    return { hasDeal: true, saved: saved, pct: pct, orig: o, curr: c }
  }
  return { hasDeal: false, saved: 0, pct: 0, orig: c, curr: c }
}

function formatCard(p, userId) {
  const d = discountInfo(p)
  const link = affLink(p.daraz_link, 'telegram', userId)
  const stars = '⭐'.repeat(Math.round(p.rating || 4))

  let text = '🛍️ *' + p.name + '*\n'
  text += '────────────────────────────\n'
  if (d.hasDeal) {
    text += '💵 আগের দাম: ~৳' + d.orig.toLocaleString() + '~\n'
    text += '✅ এখন মাত্র: *৳' + d.curr.toLocaleString() + '*\n'
    text += '🔥 ৳' + d.saved.toLocaleString() + ' ছাড় (' + d.pct + '% OFF)\n'
  } else {
    text += '💵 মূল্য: *৳' + d.curr.toLocaleString() + '*\n'
    text += '✅ সেরা দামে পাচ্ছেন\n'
  }
  text += stars + ' ' + (p.rating || 4.5) + ' রেটিং\n'
  if (p.brand) text += '🏷️ ' + p.brand + '\n'
  text += '────────────────────────────\n'
  text += '📂 ' + (p.category_label || p.category)

  return { text: text, link: link }
}

async function sendTG(chatId, method, body, token) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.json()
}

async function sendMsg(chatId, text, token, extra) {
  const body = Object.assign({
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  }, extra || {})
  return sendTG(chatId, 'sendMessage', body, token)
}

async function sendProduct(chatId, p, userId, token) {
  const fc = formatCard(p, userId)
  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Daraz এ কিনুন', url: fc.link }],
      [{ text: '📤 বন্ধুকে শেয়ার করুন', switch_inline_query: p.name }]
    ]
  }
  if (p.image_url) {
    await sendTG(chatId, 'sendPhoto', {
      chat_id: chatId,
      photo: p.image_url,
      caption: fc.text,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }, token)
  } else {
    await sendMsg(chatId, fc.text, token, { reply_markup: keyboard })
  }
}

async function delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms) })
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true })
  }

  const TOKEN = process.env.TG_BOT_TOKEN
  const body = req.body
  const callback_query = body.callback_query
  const message = body.message

  // Category button click
  if (callback_query) {
    const chatId = callback_query.message.chat.id
    const userId = callback_query.from.id
    const data = callback_query.data

    await sendTG(chatId, 'answerCallbackQuery', {
      callback_query_id: callback_query.id
    }, TOKEN)

    if (data && data.startsWith('c:')) {
      const cat = data.replace('c:', '')
      let query = supabase.from('products').select('*').eq('in_stock', true)
      if (cat === 'deals') {
        query = query.gt('discount_amount', 0)
      } else {
        query = query.eq('category', cat)
      }
      const result = await query.order('discount_amount', { ascending: false }).limit(5)
      const products = result.data || []

      if (!products.length) {
        await sendMsg(chatId, '😔 এই ক্যাটাগরিতে এখন কোনো পণ্য নেই।', TOKEN)
        return res.status(200).json({ ok: true })
      }
      await sendMsg(chatId, '✅ *' + products.length + 'টি পণ্য পাওয়া গেছে!*', TOKEN)
      for (var i = 0; i < products.length; i++) {
        await sendProduct(chatId, products[i], userId, TOKEN)
        await delay(500)
      }
    }
    return res.status(200).json({ ok: true })
  }

  if (!message || !message.text) {
    return res.status(200).json({ ok: true })
  }

  const chatId = message.chat.id
  const userId = message.from.id
  const text = message.text
  const firstName = message.from.first_name || 'বন্ধু'

  // /start
  if (text === '/start') {
    await sendMsg(chatId,
      '👋 *স্বাগতম ' + firstName + '!*\n\n' +
      '🛍️ Daraz এর সেরা ডিসকাউন্ট এখানে পাবেন!\n\n' +
      '🔍 /search মোবাইল — পণ্য খুঁজুন\n' +
      '🔥 /deals — আজকের সেরা ছাড়\n' +
      '📂 /category — ক্যাটাগরি দেখুন\n' +
      '❓ /help — সাহায্য\n\n' +
      '💡 _উদাহরণ: /search ব্লুটুথ হেডফোন_',
      TOKEN
    )
    return res.status(200).json({ ok: true })
  }

  // /help
  if (text === '/help') {
    await sendMsg(chatId,
      '❓ *সাহায্য*\n\n' +
      '`/search মোবাইল` — পণ্য খুঁজুন\n' +
      '`/deals` — সেরা ছাড়ের পণ্য\n' +
      '`/category` — ক্যাটাগরি মেনু\n\n' +
      '🛒 পণ্যের নিচের বাটনে ক্লিক করে কিনুন',
      TOKEN
    )
    return res.status(200).json({ ok: true })
  }

  // /deals
  if (text === '/deals') {
    const result = await supabase
      .from('products')
      .select('*')
      .eq('in_stock', true)
      .gt('discount_amount', 0)
      .order('discount_amount', { ascending: false })
      .limit(5)
    const products = result.data || []

    if (!products.length) {
      await sendMsg(chatId, '😔 এখন কোনো বিশেষ অফার নেই।', TOKEN)
      return res.status(200).json({ ok: true })
    }
    await sendMsg(chatId, '🔥 *' + products.length + 'টি সেরা অফার!*', TOKEN)
    for (var i = 0; i < products.length; i++) {
      await sendProduct(chatId, products[i], userId, TOKEN)
      await delay(500)
    }
    return res.status(200).json({ ok: true })
  }

  // /category
  if (text === '/category') {
    await sendMsg(chatId, '📂 *কোন ক্যাটাগরির পণ্য দেখতে চান?*', TOKEN, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📱 মোবাইল', callback_data: 'c:mobile' },
            { text: '💻 ইলেকট্রনিক্স', callback_data: 'c:electronics' }
          ],
          [
            { text: '👗 ফ্যাশন', callback_data: 'c:fashion' },
            { text: '👟 জুতা ও ব্যাগ', callback_data: 'c:shoes' }
          ],
          [
            { text: '🏠 হোম ও লিভিং', callback_data: 'c:home' },
            { text: '🍳 কিচেন', callback_data: 'c:kitchen' }
          ],
          [
            { text: '💄 বিউটি', callback_data: 'c:beauty' },
            { text: '🧸 শিশু ও খেলনা', callback_data: 'c:kids' }
          ],
          [
            { text: '🔥 সব ডিসকাউন্ট', callback_data: 'c:deals' }
          ]
        ]
      }
    })
    return res.status(200).json({ ok: true })
  }

  // /search
  if (text.startsWith('/search')) {
    const query = text.replace('/search', '').trim()
    if (!query) {
      await sendMsg(chatId,
        '🔍 এভাবে লিখুন:\n`/search মোবাইল`\n`/search হেডফোন`',
        TOKEN
      )
      return res.status(200).json({ ok: true })
    }

    const result = await supabase
      .from('products')
      .select('*')
      .eq('in_stock', true)
      .ilike('name', '%' + query + '%')
      .order('discount_amount', { ascending: false })
      .limit(5)
    const products = result.data || []

    if (!products.length) {
      await sendMsg(chatId,
        '😔 *"' + query + '"* পাওয়া যায়নি।\n\n💡 অন্য কিছু লিখুন:\n`/search মোবাইল`',
        TOKEN
      )
      return res.status(200).json({ ok: true })
    }
    await sendMsg(chatId, '✅ *' + products.length + 'টি পণ্য পাওয়া গেছে!*', TOKEN)
    for (var i = 0; i < products.length; i++) {
      await sendProduct(chatId, products[i], userId, TOKEN)
      await delay(500)
    }
    return res.status(200).json({ ok: true })
  }

  // Plain text hint
  if (!text.startsWith('/') && text.length > 2) {
    await sendMsg(chatId,
      '🔍 এভাবে খুঁজুন:\n`/search ' + text + '`',
      TOKEN
    )
  }

  return res.status(200).json({ ok: true })
}
