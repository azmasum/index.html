const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || ''
const supabase = createClient(supabaseUrl, supabaseKey)

const TOKEN = process.env.TG_BOT_TOKEN

// ── Telegram API Helper ───────────────────────────────────────
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.json()
}

async function sendMsg(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra })
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── Affiliate Link ────────────────────────────────────────────
function affLink(url, platform, userId) {
  try {
    if (!url || url === 'null' || url === '') return 'https://www.daraz.com.bd'
    if (!url.startsWith('http')) url = 'https://' + url
    const u = new URL(url)
    u.searchParams.set('sub_aff_id', process.env.DARAZ_AFF_ID || '')
    u.searchParams.set('sub_id1', 'txn_' + Date.now())
    u.searchParams.set('sub_id2', platform)
    u.searchParams.set('sub_id3', 'organic')
    u.searchParams.set('sub_id4', String(userId))
    u.searchParams.set('sub_id5', new Date().toISOString().split('T')[0])
    return u.toString()
  } catch { return 'https://www.daraz.com.bd' }
}

// ── Discount Calculator ───────────────────────────────────────
function disc(p) {
  const o = parseFloat(p.original_price) || 0
  const c = parseFloat(p.price) || 0
  if (o > c) {
    const saved = o - c
    const pct = Math.round((saved / o) * 100)
    return { hasDeal: true, saved, pct, orig: o, curr: c }
  }
  return { hasDeal: false, saved: 0, pct: 0, orig: c, curr: c }
}

// ── Format Product Card ───────────────────────────────────────
function formatCard(p, userId) {
  const d = disc(p)
  const link = affLink(p.daraz_link, 'telegram', userId)
  const stars = '⭐'.repeat(Math.round(p.rating || 4))
  let text =
    `🛍️ *${p.name}*\n` +
    `${'─'.repeat(28)}\n` +
    (d.hasDeal
      ? `💵 আগের দাম: ~৳${d.orig.toLocaleString()}~\n` +
        `✅ এখন মাত্র: *৳${d.curr.toLocaleString()}*\n` +
        `🔥 ৳${d.saved.toLocaleString()} ছাড় (${d.pct}% OFF)\n`
      : `💵 মূল্য: *৳${d.curr.toLocaleString()}*\n✅ সেরা দামে পাচ্ছেন\n`) +
    `${stars} ${p.rating || 4.5} রেটিং\n` +
    (p.brand ? `🏷️ ${p.brand}\n` : '') +
    `${'─'.repeat(28)}\n` +
    `📂 ${p.category_label || p.category}`
  return { text, link }
}

// ── Send Product ──────────────────────────────────────────────
async function sendProduct(chatId, p, userId, extra = {}) {
  const { text, link } = formatCard(p, userId)
  const keyboard = {
    inline_keyboard: [
      [{ text: '🛒 Daraz এ কিনুন', url: link }],
      [
        { text: '🔔 Wishlist এ যোগ করুন', callback_data: `wish:${p.id}` },
        { text: '📤 শেয়ার করুন', switch_inline_query: p.name }
      ]
    ]
  }
  try {
    if (p.image_url) {
      await tg('sendPhoto', { chat_id: chatId, photo: p.image_url, caption: text, parse_mode: 'Markdown', reply_markup: keyboard, ...extra })
    } else {
      await sendMsg(chatId, text, { reply_markup: keyboard, ...extra })
    }
  } catch {
    await sendMsg(chatId, text, { reply_markup: keyboard })
  }
}

// ── DB Helpers ────────────────────────────────────────────────
async function getProducts(filter = {}) {
  let q = supabase.from('products').select('*').eq('in_stock', true)
  if (filter.category) q = q.eq('category', filter.category)
  if (filter.deals) q = q.gt('discount_amount', 0)
  if (filter.search) q = q.ilike('name', `%${filter.search}%`)
  if (filter.ids) q = q.in('id', filter.ids)
  const { data } = await q.order('discount_amount', { ascending: false }).limit(filter.limit || 5)
  return data || []
}

// ── Subscribers ───────────────────────────────────────────────
async function subscribe(userId, firstName) {
  await supabase.from('subscribers').upsert({
    user_id: String(userId),
    first_name: firstName,
    subscribed: true,
    subscribed_at: new Date().toISOString()
  }, { onConflict: 'user_id' })
}

async function unsubscribe(userId) {
  await supabase.from('subscribers').update({ subscribed: false }).eq('user_id', String(userId))
}

async function isSubscribed(userId) {
  const { data } = await supabase.from('subscribers').select('subscribed').eq('user_id', String(userId)).maybeSingle()
  return data?.subscribed === true
}

// ── Wishlist ──────────────────────────────────────────────────
async function addWishlist(userId, productId) {
  const { error } = await supabase.from('wishlists').upsert({
    user_id: String(userId),
    product_id: productId,
    added_at: new Date().toISOString()
  }, { onConflict: 'user_id,product_id' })
  return !error
}

async function removeWishlist(userId, productId) {
  await supabase.from('wishlists').delete()
    .eq('user_id', String(userId))
    .eq('product_id', productId)
}

async function getWishlist(userId) {
  const { data } = await supabase
    .from('wishlists')
    .select('product_id')
    .eq('user_id', String(userId))
  if (!data?.length) return []
  const ids = data.map(w => w.product_id)
  return getProducts({ ids, limit: 10 })
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true })

  const { message, callback_query } = req.body

  // ── Callback Queries ──────────────────────────────────────
  if (callback_query) {
    const chatId  = callback_query.message.chat.id
    const userId  = callback_query.from.id
    const data    = callback_query.data

    await tg('answerCallbackQuery', { callback_query_id: callback_query.id })

    // Category
    if (data.startsWith('c:')) {
      const cat = data.replace('c:', '')
      const products = cat === 'deals'
        ? await getProducts({ deals: true })
        : await getProducts({ category: cat })

      if (!products.length) {
        await sendMsg(chatId, '😔 এই ক্যাটাগরিতে এখন কোনো পণ্য নেই।')
        return res.status(200).json({ ok: true })
      }
      await sendMsg(chatId, `✅ *${products.length}টি পণ্য পাওয়া গেছে!*`)
      for (const p of products) { await sendProduct(chatId, p, userId); await delay(400) }
    }

    // Wishlist add
    if (data.startsWith('wish:')) {
      const productId = data.replace('wish:', '')
      const ok = await addWishlist(userId, productId)
      await tg('answerCallbackQuery', {
        callback_query_id: callback_query.id,
        text: ok ? '❤️ Wishlist এ যোগ হয়েছে!' : '⚠️ ইতিমধ্যে Wishlist এ আছে',
        show_alert: true
      })
    }

    // Wishlist remove
    if (data.startsWith('unwish:')) {
      const productId = data.replace('unwish:', '')
      await removeWishlist(userId, productId)
      await tg('answerCallbackQuery', {
        callback_query_id: callback_query.id,
        text: '🗑️ Wishlist থেকে সরানো হয়েছে',
        show_alert: true
      })
    }

    // Unsubscribe confirm
    if (data === 'confirm_unsub') {
      await unsubscribe(userId)
      await sendMsg(chatId, '😔 আপনি Unsubscribe করেছেন।\nআবার Subscribe করতে /subscribe লিখুন।')
    }

    return res.status(200).json({ ok: true })
  }

  if (!message?.text) return res.status(200).json({ ok: true })

  const chatId    = message.chat.id
  const userId    = message.from.id
  const firstName = message.from.first_name || 'বন্ধু'
  const text      = message.text.trim()

  // ── /start ────────────────────────────────────────────────
  if (text === '/start') {
    await sendMsg(chatId,
      `👋 *স্বাগতম ${firstName}!*\n\n` +
      `🛍️ Daraz BD এর সেরা ডিসকাউন্ট এখানে!\n\n` +
      `🔍 /search [নাম] — পণ্য খুঁজুন\n` +
      `🔥 /deals — আজকের সেরা ছাড়\n` +
      `📂 /category — ক্যাটাগরি দেখুন\n` +
      `🔔 /subscribe — Daily Deal Alert চালু করুন\n` +
      `❤️ /wishlist — আপনার পছন্দের পণ্য\n` +
      `❓ /help — সাহায্য\n\n` +
      `💡 _উদাহরণ: /search ব্লুটুথ হেডফোন_`
    )
    return res.status(200).json({ ok: true })
  }

  // ── /help ─────────────────────────────────────────────────
  if (text === '/help') {
    await sendMsg(chatId,
      `❓ *সাহায্য*\n\n` +
      `\`/search মোবাইল\` — পণ্য খুঁজুন\n` +
      `\`/deals\` — সেরা ছাড়\n` +
      `\`/category\` — ক্যাটাগরি মেনু\n` +
      `\`/subscribe\` — Daily Deal Alert চালু\n` +
      `\`/unsubscribe\` — Alert বন্ধ করুন\n` +
      `\`/wishlist\` — পছন্দের পণ্য দেখুন\n\n` +
      `🛒 পণ্যের নিচে বাটনে ক্লিক করে কিনুন\n` +
      `❤️ Wishlist বাটনে ক্লিক করে save করুন`
    )
    return res.status(200).json({ ok: true })
  }

  // ── /deals ────────────────────────────────────────────────
  if (text === '/deals') {
    const products = await getProducts({ deals: true })
    if (!products.length) {
      await sendMsg(chatId, '😔 এখন কোনো বিশেষ অফার নেই।')
      return res.status(200).json({ ok: true })
    }
    await sendMsg(chatId, `🔥 *${products.length}টি সেরা অফার!*`)
    for (const p of products) { await sendProduct(chatId, p, userId); await delay(400) }
    return res.status(200).json({ ok: true })
  }

  // ── /category ─────────────────────────────────────────────
  if (text === '/category') {
    await sendMsg(chatId, '📂 *কোন ক্যাটাগরির পণ্য দেখতে চান?*', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 মোবাইল', callback_data: 'c:mobile' }, { text: '💻 ইলেকট্রনিক্স', callback_data: 'c:electronics' }],
          [{ text: '👗 ফ্যাশন', callback_data: 'c:fashion' }, { text: '👟 জুতা ও ব্যাগ', callback_data: 'c:shoes' }],
          [{ text: '🏠 হোম ও লিভিং', callback_data: 'c:home' }, { text: '🍳 কিচেন', callback_data: 'c:kitchen' }],
          [{ text: '💄 বিউটি', callback_data: 'c:beauty' }, { text: '🧸 শিশু ও খেলনা', callback_data: 'c:kids' }],
          [{ text: '🔥 সব ডিসকাউন্ট', callback_data: 'c:deals' }]
        ]
      }
    })
    return res.status(200).json({ ok: true })
  }

  // ── /search ───────────────────────────────────────────────
  if (text.startsWith('/search')) {
    const query = text.replace('/search', '').trim()
    if (!query) {
      await sendMsg(chatId, '🔍 এভাবে লিখুন:\n`/search মোবাইল`')
      return res.status(200).json({ ok: true })
    }
    const products = await getProducts({ search: query })
    if (!products.length) {
      await sendMsg(chatId, `😔 *"${query}"* পাওয়া যায়নি।\n\n💡 অন্য কিছু লিখুন:\n\`/search মোবাইল\``)
      return res.status(200).json({ ok: true })
    }
    await sendMsg(chatId, `✅ *${products.length}টি পণ্য পাওয়া গেছে!*`)
    for (const p of products) { await sendProduct(chatId, p, userId); await delay(400) }
    return res.status(200).json({ ok: true })
  }

  // ── /subscribe ────────────────────────────────────────────
  if (text === '/subscribe') {
    const already = await isSubscribed(userId)
    if (already) {
      await sendMsg(chatId,
        `✅ আপনি ইতিমধ্যে Subscribe করা আছেন!\n\n` +
        `প্রতিদিন সকালে সেরা deals পাবেন।\n` +
        `বন্ধ করতে: /unsubscribe`
      )
      return res.status(200).json({ ok: true })
    }
    await subscribe(userId, firstName)
    await sendMsg(chatId,
      `🔔 *সফলভাবে Subscribe হয়েছেন!*\n\n` +
      `✅ প্রতিদিন সকাল ১০টায় সেরা deals পাবেন\n` +
      `✅ Price Drop হলে তাৎক্ষণিক notification\n` +
      `✅ Flash Sale এর আগেই জানতে পারবেন\n\n` +
      `বন্ধ করতে: /unsubscribe`
    )
    return res.status(200).json({ ok: true })
  }

  // ── /unsubscribe ──────────────────────────────────────────
  if (text === '/unsubscribe') {
    await sendMsg(chatId, '⚠️ আপনি কি সত্যিই Unsubscribe করতে চান?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ হ্যাঁ, বন্ধ করুন', callback_data: 'confirm_unsub' },
          { text: '❌ না, রাখুন', callback_data: 'cancel_unsub' }
        ]]
      }
    })
    return res.status(200).json({ ok: true })
  }

  // ── /wishlist ─────────────────────────────────────────────
  if (text === '/wishlist') {
    const products = await getWishlist(userId)
    if (!products.length) {
      await sendMsg(chatId,
        `❤️ *আপনার Wishlist খালি!*\n\n` +
        `পণ্যের নিচে *"🔔 Wishlist এ যোগ করুন"* বাটনে ক্লিক করুন।`
      )
      return res.status(200).json({ ok: true })
    }
    await sendMsg(chatId, `❤️ *আপনার Wishlist (${products.length}টি পণ্য)*`)
    for (const p of products) {
      const { text: cardText, link } = formatCard(p, userId)
      await sendMsg(chatId, cardText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛒 Daraz এ কিনুন', url: link }],
            [{ text: '🗑️ Wishlist থেকে সরান', callback_data: `unwish:${p.id}` }]
          ]
        }
      })
      await delay(400)
    }
    return res.status(200).json({ ok: true })
  }

  // ── Plain text → search hint ──────────────────────────────
  if (!text.startsWith('/') && text.length > 2) {
    await sendMsg(chatId, `🔍 এভাবে খুঁজুন:\n\`/search ${text}\``)
  }

  return res.status(200).json({ ok: true })
}
