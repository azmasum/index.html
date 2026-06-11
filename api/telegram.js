import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

function affLink(url, platform, userId) {
  try {
    const u = new URL(url)
    u.searchParams.set('sub_aff_id', process.env.DARAZ_AFF_ID || '')
    u.searchParams.set('sub_id1', `txn_${Date.now()}`)
    u.searchParams.set('sub_id2', platform)
    u.searchParams.set('sub_id3', 'organic')
    u.searchParams.set('sub_id4', String(userId))
    u.searchParams.set('sub_id5', new Date().toISOString().split('T')[0])
    return u.toString()
  } catch { return url }
}

function discountInfo(p) {
  const o = +p.original_price || 0
  const c = +p.price || 0
  if (o > c) {
    const saved = o - c
    const pct = Math.round((saved / o) * 100)
    return { hasDeal: true, saved, pct, orig: o, curr: c }
  }
  return { hasDeal: false, saved: 0, pct: 0, orig: c, curr: c }
}

function formatCard(p, userId) {
  const d = discountInfo(p)
  const link = affLink(p.daraz_link, 'telegram', userId)
  const stars = '⭐'.repeat(Math.round(p.rating || 4))

  const text =
    `🛍️ *${p.name}*\n` +
    `${'─'.repeat(28)}\n` +
    (d.hasDeal
      ? `💵 আগের দাম: ~৳${d.orig.toLocaleString()}~\n` +
        `✅ এখন মাত্র: *৳${d.curr.toLocaleString()}*\n` +
        `🔥 ৳${d.saved.toLocaleString()} ছাড় (${d.pct}% OFF)\n`
      : `💵 মূল্য: *৳${d.curr.toLocaleString()}*\n` +
        `✅ সেরা দামে পাচ্ছেন\n`) +
    `${stars} ${p.rating || 4.5} রেটিং\n` +
    (p.brand ? `🏷️ ${p.brand}\n` : '') +
    `${'─'.repeat(28)}\n` +
    `📂 ${p.category_label || p.category}`

  return { text, link }
}

async function sendProduct(chatId, p, userId, token) {
  const { text, link } = formatCard(p, userId)
  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Daraz এ কিনুন', url: link }],
      [{ text: '📤 বন্ধুকে শেয়ার করুন', switch_inline_query: p.name }]
    ]
  }

  const body = p.image_url
    ? {
        chat_id: chatId,
        photo: p.image_url,
        caption: text,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    : {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }

  const method = p.image_url ? 'sendPhoto' : 'sendMessage'

  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function sendMessage(chatId, text, token, extra = {}) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...extra
    })
  })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true })

  const TOKEN = process.env.TG_BOT_TOKEN
  const { message, callback_query } = req.body

  // ── Callback (Category buttons) ──────────────────────────
  if (callback_query) {
    const chatId = callback_query.message.chat.id
    const userId = callback_query.from.id
    const data = callback_query.data

    await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callback_query.id })
    })

    if (data.startsWith('c:')) {
      const cat = data.replace('c:', '')
      let query = supabase.from('products').select('*').eq('in_stock', true)

      if (cat === 'deals') {
        query = query.gt('discount_amount', 0)
      } else {
        query = query.eq('category', cat)
      }

      const { data: products } = await query
        .order('discount_amount', { ascending: false })
        .limit(5)

      if (!products?.length) {
        await sendMessage(chatId, '😔 এই ক্যাটাগরিতে এখন কোনো পণ্য নেই।', TOKEN)
        return res.status(200).json({ ok: true })
      }

      await sendMessage(chatId, `✅ *${products.length}টি পণ্য পাওয়া গেছে!*`, TOKEN)

      for (const p of products) {
        await sendProduct(chatId, p, userId, TOKEN)
        await new Promise(r => setTimeout(r, 500))
      }
    }
    return res.status(200).json({ ok: true })
  }

  if (!message?.text) return res.status(200).json({ ok: true })

  const chatId = message.chat.id
  const userId = message.from.id
  const text = message.text
  const firstName = message.from.first_name || 'বন্ধু'

  // ── /start ────────────────────────────────────────────────
  if (text === '/start') {
    await sendMessage(chatId,
      `👋 *স্বাগতম ${firstName}!*\n\n` +
      `🛍️ Daraz এর সেরা ডিসকাউন্ট এখানে পাবেন!\n\n` +
      `🔍 /search মোবাইল — পণ্য খুঁজুন\n` +
      `🔥 /deals — আজকের সেরা ছাড়\n` +
      `📂 /category — ক্যাটাগরি দেখুন\n` +
      `❓ /help — সাহায্য\n\n` +
      `💡 _উদাহরণ: /search ব্লুটুথ হেডফোন_`,
      TOKEN
    )
    return res.status(200).json({ ok: true })
  }

  // ── /help ─────────────────────────────────────────────────
  if (text === '/help') {
    await sendMessage(chatId,
      `❓ *সাহায্য*\n\n` +
      `\`/search মোবাইল\` — পণ্য খুঁজুন\n` +
      `\`/deals\` — সেরা ছাড়ের পণ্য\n` +
      `\`/category\` — ক্যাটাগরি মেনু\n\n` +
      `🛒 পণ্যের নিচের বাটনে ক্লিক করে কিনুন`,
      TOKEN
    )
    return res.status(200).json({ ok: true })
  }

  // ── /deals ────────────────────────────────────────────────
  if (text === '/deals') {
    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('in_stock', true)
      .gt('discount_amount', 0)
      .order('discount_amount', { ascending: false })
      .limit(5)

    if (!products?.length) {
      await sendMessage(chatId, '😔 এখন কোনো বিশেষ অফার নেই। পরে আবার চেষ্টা করুন।', TOKEN)
      return res.status(200).json({ ok: true })
    }

    await sendMessage(chatId, `🔥 *${products.length}টি সেরা অফার!*`, TOKEN)

    for (const p of products) {
      await sendProduct(chatId, p, userId, TOKEN)
      await new Promise(r => setTimeout(r, 500))
    }
    return res.status(200).json({ ok: true })
  }

  // ── /category ─────────────────────────────────────────────
  if (text === '/category') {
    await sendMessage(chatId, '📂 *কোন ক্যাটাগরির পণ্য দেখতে চান?*', TOKEN, {
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

  // ── /search ───────────────────────────────────────────────
  if (text.startsWith('/search')) {
    const query = text.replace('/search', '').trim()

    if (!query) {
      await sendMessage(chatId,
        `🔍 এভাবে লিখুন:\n\`/search মোবাইল\`\n\`/search হেডফোন\``,
        TOKEN
      )
      return res.status(200).json({ ok: true })
    }

    const { data: products } = await supabase
      .from('products')
      .select('*')
      .eq('in_stock', true)
      .ilike('name', `%${query}%`)
      .order('discount_amount', { ascending: false })
      .limit(5)

    if (!products?.length) {
      await sendMessage(chatId,
        `😔 *"${query}"* এর জন্য কোনো পণ্য পাওয়া যায়নি।\n\n💡 অন্য কিছু লিখুন:\n\`/search মোবাইল\``,
        TOKEN
      )
      return res.status(200).json({ ok: true })
    }

    await sendMessage(chatId, `✅ *${products.length}টি পণ্য পাওয়া গেছে!*`, TOKEN)

    for (const p of products) {
      await sendProduct(chatId, p, userId, TOKEN)
      await new Promise(r => setTimeout(r, 500))
    }
    return res.status(200).json({ ok: true })
  }

  // ── Plain text → search hint ──────────────────────────────
  if (!text.startsWith('/') && text.length > 2) {
    await sendMessage(chatId,
      `🔍 এভাবে খুঁজুন:\n\`/search ${text}\``,
      TOKEN
    )
  }

  return res.status(200).json({ ok: true })
}
