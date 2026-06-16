// api/telegram.js — FINAL VERSION with Growth Features
// নতুন: Referral System, Welcome Message, Stats, Top10

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
)

const TOKEN          = process.env.TG_BOT_TOKEN
const CHANNEL_ID     = '-1002210302760'
const GROUP_ID       = '-1004320220003'
const ADMIN_CHAT_ID  = process.env.TG_ADMIN_CHAT_ID
const BOT_USERNAME   = 'DarazDealBD_bot'

// ── Telegram API ──────────────────────────────────────────────
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

async function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Affiliate Link ────────────────────────────────────────────
function affLink(url, platform, userId) {
  try {
    if (!url || !url.startsWith('http')) return 'https://www.daraz.com.bd'
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

// ── Discount ──────────────────────────────────────────────────
function disc(p) {
  const o = parseFloat(p.original_price) || 0
  const c = parseFloat(p.price) || 0
  if (o > c) { const s=o-c, pct=Math.round((s/o)*100); return {hasDeal:true,saved:s,pct,orig:o,curr:c} }
  return {hasDeal:false,saved:0,pct:0,orig:c,curr:c}
}

// ── Format Card ───────────────────────────────────────────────
function formatCard(p, userId) {
  const d = disc(p)
  const link = affLink(p.daraz_link, 'telegram', userId)
  const stars = '⭐'.repeat(Math.round(p.rating || 4))
  let text =
    `🛍️ *${p.name}*\n${'─'.repeat(28)}\n` +
    (d.hasDeal
      ? `💵 আগের দাম: ~৳${d.orig.toLocaleString()}~\n✅ এখন: *৳${d.curr.toLocaleString()}*\n🔥 ৳${d.saved.toLocaleString()} ছাড় (${d.pct}% OFF)\n`
      : `💵 মূল্য: *৳${d.curr.toLocaleString()}*\n✅ সেরা দামে পাচ্ছেন\n`) +
    `${stars} ${p.rating||4.5}\n` +
    (p.brand ? `🏷️ ${p.brand}\n` : '') +
    `${'─'.repeat(28)}\n📂 ${p.category_label||p.category}`
  return { text, link }
}

// ── Send Product ──────────────────────────────────────────────
async function sendProduct(chatId, p, userId) {
  const { text, link } = formatCard(p, userId)
  const kb = { inline_keyboard: [
    [{ text: '🛒 Daraz এ কিনুন', url: link }],
    [
      { text: '❤️ Wishlist', callback_data: `wish:${p.id}` },
      { text: '📤 শেয়ার করুন', switch_inline_query: p.name }
    ]
  ]}
  try {
    if (p.image_url) await tg('sendPhoto', { chat_id:chatId, photo:p.image_url, caption:text, parse_mode:'Markdown', reply_markup:kb })
    else await sendMsg(chatId, text, { reply_markup: kb })
  } catch { await sendMsg(chatId, text, { reply_markup: kb }) }
}

// ── DB Helpers ────────────────────────────────────────────────
async function getProducts(filter = {}) {
  let q = supabase.from('products').select('*').eq('in_stock', true)
  if (filter.category) q = q.eq('category', filter.category)
  if (filter.deals)    q = q.gt('discount_amount', 0)
  if (filter.search)   q = q.ilike('name', `%${filter.search}%`)
  if (filter.ids)      q = q.in('id', filter.ids)
  const { data } = await q.order('discount_amount', {ascending:false}).limit(filter.limit||5)
  return data || []
}

// ── Referral System ───────────────────────────────────────────
async function registerUser(userId, firstName, referredBy = null) {
  const { data: existing } = await supabase
    .from('users').select('id').eq('user_id', String(userId)).maybeSingle()

  if (!existing) {
    await supabase.from('users').insert({
      user_id:     String(userId),
      first_name:  firstName,
      referred_by: referredBy ? String(referredBy) : null,
      joined_at:   new Date().toISOString(),
      referral_count: 0
    })

    // Referrer কে credit দাও
    if (referredBy) {
      await supabase.rpc('increment_referral', { uid: String(referredBy) }).catch(() => {})

      // Referrer কে notify করো
      await sendMsg(referredBy,
        `🎉 *নতুন Referral!*\n\n` +
        `${firstName} আপনার link দিয়ে join করেছে!\n` +
        `আপনার মোট referral দেখতে: /mystats`
      )
    }

    // Admin কে notify
    if (ADMIN_CHAT_ID) {
      await sendMsg(ADMIN_CHAT_ID,
        `👤 নতুন User: *${firstName}*\n` +
        `ID: ${userId}\n` +
        (referredBy ? `Referred by: ${referredBy}` : 'Direct join')
      )
    }
    return true // new user
  }
  return false // existing user
}

async function getReferralLink(userId) {
  return `https://t.me/${BOT_USERNAME}?start=ref_${userId}`
}

async function getUserStats(userId) {
  const { data } = await supabase
    .from('users').select('*').eq('user_id', String(userId)).maybeSingle()
  return data
}

// ── Subscribe ─────────────────────────────────────────────────
async function subscribe(userId, firstName) {
  await supabase.from('subscribers').upsert(
    { user_id: String(userId), first_name: firstName, subscribed: true, subscribed_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  )
}
async function unsubscribe(userId) {
  await supabase.from('subscribers').update({ subscribed: false }).eq('user_id', String(userId))
}
async function isSubscribed(userId) {
  const { data } = await supabase.from('subscribers').select('subscribed').eq('user_id', String(userId)).maybeSingle()
  return data?.subscribed === true
}

// ── Wishlist ──────────────────────────────────────────────────
async function addWish(userId, productId) {
  const { error } = await supabase.from('wishlists').upsert(
    { user_id: String(userId), product_id: productId, added_at: new Date().toISOString() },
    { onConflict: 'user_id,product_id' }
  )
  return !error
}
async function removeWish(userId, productId) {
  await supabase.from('wishlists').delete().eq('user_id', String(userId)).eq('product_id', productId)
}
async function getWishlist(userId) {
  const { data } = await supabase.from('wishlists').select('product_id').eq('user_id', String(userId))
  if (!data?.length) return []
  return getProducts({ ids: data.map(w => w.product_id), limit: 10 })
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true })

  const { message, callback_query, my_chat_member } = req.body

  // ── New Member joined Channel/Group ──────────────────────
  if (my_chat_member) {
    const newStatus = my_chat_member.new_chat_member?.status
    const chatId    = my_chat_member.chat?.id
    const userId    = my_chat_member.from?.id
    const firstName = my_chat_member.from?.first_name || 'বন্ধু'

    if (newStatus === 'member' && (chatId == CHANNEL_ID || chatId == GROUP_ID)) {
      // Welcome message পাঠাও
      await sendMsg(userId,
        `👋 *স্বাগতম ${firstName}!*\n\n` +
        `🎉 আপনি আমাদের Community তে join করেছেন!\n\n` +
        `🛍️ এখন Bot থেকে সেরা deals পান:\n` +
        `👉 @${BOT_USERNAME}\n\n` +
        `🔍 /search মোবাইল — পণ্য খুঁজুন\n` +
        `🔥 /deals — আজকের সেরা ছাড়\n` +
        `🔔 /subscribe — Daily Deal Alert চালু করুন`
      ).catch(() => {})
    }
    return res.status(200).json({ ok: true })
  }

  // ── Callback Queries ──────────────────────────────────────
  if (callback_query) {
    const chatId  = callback_query.message.chat.id
    const userId  = callback_query.from.id
    const data    = callback_query.data

    await tg('answerCallbackQuery', { callback_query_id: callback_query.id })

    if (data.startsWith('c:')) {
      const cat = data.replace('c:', '')
      const products = cat === 'deals' ? await getProducts({deals:true}) : await getProducts({category:cat})
      if (!products.length) { await sendMsg(chatId, '😔 এই ক্যাটাগরিতে এখন কোনো পণ্য নেই।'); return res.status(200).json({ok:true}) }
      await sendMsg(chatId, `✅ *${products.length}টি পণ্য!*`)
      for (const p of products) { await sendProduct(chatId, p, userId); await delay(400) }
    }

    if (data.startsWith('wish:')) {
      const ok = await addWish(userId, data.replace('wish:',''))
      await tg('answerCallbackQuery', { callback_query_id: callback_query.id, text: ok ? '❤️ Wishlist এ যোগ হয়েছে!' : '⚠️ ইতিমধ্যে আছে!', show_alert: true })
    }

    if (data.startsWith('unwish:')) {
      await removeWish(userId, data.replace('unwish:',''))
      await tg('answerCallbackQuery', { callback_query_id: callback_query.id, text: '🗑️ সরানো হয়েছে', show_alert: true })
    }

    if (data === 'confirm_unsub') {
      await unsubscribe(userId)
      await sendMsg(chatId, '😔 Unsubscribe করা হয়েছে। /subscribe দিয়ে আবার চালু করুন।')
    }

    return res.status(200).json({ ok: true })
  }

  if (!message?.text) return res.status(200).json({ ok: true })

  const chatId    = message.chat.id
  const userId    = message.from.id
  const firstName = message.from.first_name || 'বন্ধু'
  const text      = message.text.trim()

  // ── /start (with referral support) ───────────────────────
  if (text.startsWith('/start')) {
    const parts = text.split(' ')
    const param = parts[1] || ''
    let referredBy = null

    if (param.startsWith('ref_')) {
      referredBy = param.replace('ref_', '')
      if (referredBy === String(userId)) referredBy = null // নিজেকে refer করা যাবে না
    }

    const isNew = await registerUser(userId, firstName, referredBy)

    await sendMsg(chatId,
      `👋 *স্বাগতম ${firstName}!*\n\n` +
      (isNew ? `🎉 আপনাকে প্রথমবার দেখছি! স্বাগতম!\n\n` : '') +
      `🛍️ Daraz BD এর সেরা ডিসকাউন্ট এখানে!\n\n` +
      `🔍 /search [নাম] — পণ্য খুঁজুন\n` +
      `🔥 /deals — আজকের সেরা ছাড়\n` +
      `📂 /category — ক্যাটাগরি দেখুন\n` +
      `🔔 /subscribe — Daily Deal Alert\n` +
      `❤️ /wishlist — পছন্দের পণ্য\n` +
      `🔗 /refer — বন্ধুদের invite করুন\n` +
      `📊 /mystats — আপনার stats\n` +
      `🏆 /top10 — সেরা ১০টি পণ্য\n\n` +
      `💡 _উদাহরণ: /search ব্লুটুথ হেডফোন_`
    )
    return res.status(200).json({ ok: true })
  }

  // ── /refer — Referral Link ────────────────────────────────
  if (text === '/refer') {
    await registerUser(userId, firstName)
    const link = await getReferralLink(userId)
    const stats = await getUserStats(userId)
    const count = stats?.referral_count || 0

    await sendMsg(chatId,
      `🔗 *আপনার Referral Link:*\n\n` +
      `\`${link}\`\n\n` +
      `📊 এখন পর্যন্ত: *${count}জন* invite করেছেন\n\n` +
      `📣 *কীভাবে শেয়ার করবেন:*\n` +
      `→ Facebook Group এ post করুন\n` +
      `→ WhatsApp এ বন্ধুদের পাঠান\n` +
      `→ Instagram Bio তে দিন\n\n` +
      `💡 বন্ধু join করলে আপনি notification পাবেন!`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📤 WhatsApp এ শেয়ার', url: `https://wa.me/?text=${encodeURIComponent(`🛍️ Daraz এর সেরা ডিল পেতে এই Bot join করো!\n${link}`)}` },
            { text: '📘 Facebook এ শেয়ার', url: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}` }
          ]]
        }
      }
    )
    return res.status(200).json({ ok: true })
  }

  // ── /mystats ──────────────────────────────────────────────
  if (text === '/mystats') {
    await registerUser(userId, firstName)
    const stats = await getUserStats(userId)
    const subbed = await isSubscribed(userId)
    const { data: wishCount } = await supabase.from('wishlists').select('id', {count:'exact'}).eq('user_id', String(userId))

    await sendMsg(chatId,
      `📊 *আপনার Stats*\n\n` +
      `👤 নাম: ${firstName}\n` +
      `🔔 Subscribe: ${subbed ? '✅ চালু' : '❌ বন্ধ'}\n` +
      `❤️ Wishlist: ${wishCount?.length || 0}টি পণ্য\n` +
      `🔗 Referrals: ${stats?.referral_count || 0}জন\n` +
      `📅 Join: ${stats?.joined_at ? new Date(stats.joined_at).toLocaleDateString('bn-BD') : 'আজ'}\n\n` +
      `🔗 আপনার Referral Link:\n/refer`
    )
    return res.status(200).json({ ok: true })
  }

  // ── /top10 ────────────────────────────────────────────────
  if (text === '/top10') {
    const products = await getProducts({ deals: true, limit: 10 })
    if (!products.length) { await sendMsg(chatId, '😔 এখন কোনো deal নেই।'); return res.status(200).json({ok:true}) }

    let msg = `🏆 *আজকের সেরা ১০টি ডিল!*\n${'═'.repeat(28)}\n\n`
    products.forEach((p, i) => {
      const d = disc(p)
      msg += `${i+1}. *${p.name.substring(0,35)}*\n`
      msg += `   ৳${p.price} ${d.hasDeal ? `| 🔥${d.pct}% ছাড়` : ''}\n\n`
    })
    msg += `\nবিস্তারিত দেখতে /deals বা /search করুন`

    await sendMsg(chatId, msg, {
      reply_markup: { inline_keyboard: [[
        { text: '🔥 সব deals দেখুন', callback_data: 'c:deals' }
      ]]}
    })
    return res.status(200).json({ ok: true })
  }

  // ── /deals ────────────────────────────────────────────────
  if (text === '/deals') {
    const products = await getProducts({ deals: true })
    if (!products.length) { await sendMsg(chatId, '😔 এখন কোনো বিশেষ অফার নেই।'); return res.status(200).json({ok:true}) }
    await sendMsg(chatId, `🔥 *${products.length}টি সেরা অফার!*`)
    for (const p of products) { await sendProduct(chatId, p, userId); await delay(400) }
    return res.status(200).json({ ok: true })
  }

  // ── /category ─────────────────────────────────────────────
  if (text === '/category') {
    await sendMsg(chatId, '📂 *কোন ক্যাটাগরি?*', {
      reply_markup: { inline_keyboard: [
        [{text:'📱 মোবাইল',callback_data:'c:mobile'},{text:'💻 ইলেকট্রনিক্স',callback_data:'c:electronics'}],
        [{text:'👗 ফ্যাশন',callback_data:'c:fashion'},{text:'👟 জুতা ও ব্যাগ',callback_data:'c:shoes'}],
        [{text:'🏠 হোম ও লিভিং',callback_data:'c:home'},{text:'🍳 কিচেন',callback_data:'c:kitchen'}],
        [{text:'💄 বিউটি',callback_data:'c:beauty'},{text:'🧸 শিশু ও খেলনা',callback_data:'c:kids'}],
        [{text:'🔥 সব ডিসকাউন্ট',callback_data:'c:deals'}]
      ]}
    })
    return res.status(200).json({ ok: true })
  }

  // ── /search ───────────────────────────────────────────────
  if (text.startsWith('/search')) {
    const query = text.replace('/search', '').trim()
    if (!query) { await sendMsg(chatId, '🔍 এভাবে লিখুন:\n`/search মোবাইল`'); return res.status(200).json({ok:true}) }
    const products = await getProducts({ search: query })
    if (!products.length) { await sendMsg(chatId, `😔 *"${query}"* পাওয়া যায়নি।\n\n💡 /category থেকে দেখুন`); return res.status(200).json({ok:true}) }
    await sendMsg(chatId, `✅ *${products.length}টি পণ্য!*`)
    for (const p of products) { await sendProduct(chatId, p, userId); await delay(400) }
    return res.status(200).json({ ok: true })
  }

  // ── /subscribe ────────────────────────────────────────────
  if (text === '/subscribe') {
    const already = await isSubscribed(userId)
    if (already) { await sendMsg(chatId, `✅ ইতিমধ্যে Subscribe করা আছেন!\nবন্ধ করতে: /unsubscribe`); return res.status(200).json({ok:true}) }
    await subscribe(userId, firstName)
    await sendMsg(chatId, `🔔 *সফলভাবে Subscribe হয়েছেন!*\n\n✅ প্রতিদিন সকাল ১০টায় deals পাবেন\nবন্ধ করতে: /unsubscribe`)
    return res.status(200).json({ ok: true })
  }

  // ── /unsubscribe ──────────────────────────────────────────
  if (text === '/unsubscribe') {
    await sendMsg(chatId, '⚠️ Unsubscribe করবেন?', {
      reply_markup: { inline_keyboard: [[
        {text:'✅ হ্যাঁ',callback_data:'confirm_unsub'},
        {text:'❌ না',callback_data:'cancel_unsub'}
      ]]}
    })
    return res.status(200).json({ ok: true })
  }

  // ── /wishlist ─────────────────────────────────────────────
  if (text === '/wishlist') {
    const products = await getWishlist(userId)
    if (!products.length) { await sendMsg(chatId, `❤️ *Wishlist খালি!*\n\nপণ্যের নিচে ❤️ বাটনে ক্লিক করুন।`); return res.status(200).json({ok:true}) }
    await sendMsg(chatId, `❤️ *আপনার Wishlist (${products.length}টি)*`)
    for (const p of products) {
      const { text: t, link } = formatCard(p, userId)
      await sendMsg(chatId, t, { reply_markup: { inline_keyboard: [
        [{text:'🛒 কিনুন',url:link}],
        [{text:'🗑️ সরান',callback_data:`unwish:${p.id}`}]
      ]}})
      await delay(400)
    }
    return res.status(200).json({ ok: true })
  }

  // ── /help ─────────────────────────────────────────────────
  if (text === '/help') {
    await sendMsg(chatId,
      `❓ *সব Commands:*\n\n` +
      `\`/search মোবাইল\` — পণ্য খুঁজুন\n` +
      `\`/deals\` — সেরা ছাড়\n` +
      `\`/category\` — ক্যাটাগরি\n` +
      `\`/top10\` — সেরা ১০ পণ্য\n` +
      `\`/subscribe\` — Daily Alert চালু\n` +
      `\`/unsubscribe\` — Alert বন্ধ\n` +
      `\`/wishlist\` — পছন্দের পণ্য\n` +
      `\`/refer\` — বন্ধুদের invite করুন\n` +
      `\`/mystats\` — আপনার stats\n\n` +
      `📢 Channel: @darazme\n` +
      `👥 Group: @DarazDealBDBD`
    )
    return res.status(200).json({ ok: true })
  }

  // ── Plain text ────────────────────────────────────────────
  if (!text.startsWith('/') && text.length > 2) {
    await sendMsg(chatId, `🔍 এভাবে খুঁজুন:\n\`/search ${text}\``)
  }

  return res.status(200).json({ ok: true })
}
