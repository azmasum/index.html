const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
)

const TOKEN      = process.env.TG_BOT_TOKEN
const CHANNEL_ID = '-1002210302760'   // @darazme — শুধু এখানে post হবে

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  })
  return res.json()
}

function affLink(url, platform) {
  try {
    if (!url || !url.startsWith('http')) return 'https://www.daraz.com.bd'
    const u = new URL(url)
    u.searchParams.set('sub_aff_id', process.env.DARAZ_AFF_ID || '')
    u.searchParams.set('sub_id1', 'txn_' + Date.now())
    u.searchParams.set('sub_id2', platform)
    u.searchParams.set('sub_id3', 'manual_post')
    return u.toString()
  } catch { return 'https://www.daraz.com.bd' }
}

function buildText(products, title, footer) {
  let text = `${title || '🔥 *বিশেষ অফার!*'}\n${'═'.repeat(28)}\n\n`
  products.forEach((p, i) => {
    const orig  = parseFloat(p.original_price) || 0
    const curr  = parseFloat(p.price) || 0
    const saved = orig > curr ? orig - curr : 0
    const pct   = orig > 0 ? Math.round((saved / orig) * 100) : 0
    text += `${i + 1}️⃣ *${p.name}*\n`
    if (saved > 0) {
      text += `   ~~৳${orig.toLocaleString()}~~ → *৳${curr.toLocaleString()}*\n`
      text += `   🔥 ৳${saved.toLocaleString()} ছাড় (${pct}% OFF)\n\n`
    } else {
      text += `   💰 মাত্র *৳${curr.toLocaleString()}*\n\n`
    }
  })
  text += '═'.repeat(28) + '\n'
  text += footer || `🤖 @DarazDealBD_bot\n#DarazBD #Deal`
  return text
}

async function sendToChat(chatId, products, title, footer) {
  const text    = buildText(products, title, footer)
  const buttons = products.map(p => ([{
    text: `🛒 ${p.name.substring(0, 30)}`,
    url:  affLink(p.daraz_link, 'channel')
  }]))
  buttons.push([{ text: '🤖 Bot এ আরো দেখুন', url: 'https://t.me/DarazDealBD_bot' }])
  const keyboard = { inline_keyboard: buttons }
  const firstImg = products.find(p => p.image_url && p.image_url.startsWith('http'))

  if (firstImg) {
    const photoResult = await tg('sendPhoto', {
      chat_id: chatId, photo: firstImg.image_url,
      caption: text, parse_mode: 'Markdown', reply_markup: keyboard
    })
    // Photo fail করলে (broken/invalid URL) text message এ fallback করো
    if (photoResult.ok) return photoResult
  }

  return tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: keyboard
  })
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { productIds, title, footer, targets = ['channel'], scheduleAt = null } = req.body

  if (!productIds?.length) return res.status(400).json({ error: 'No products selected' })

  // Schedule হলে DB তে save
  if (scheduleAt) {
    const { data, error } = await supabase.from('scheduled_posts').insert({
      product_ids:         JSON.stringify(productIds),
      title,
      footer,
      post_type:           'custom',
      send_to_channel:     true,   // সবসময় শুধু channel
      send_to_group:       false,  // group এ আর যাবে না
      send_to_subscribers: targets.includes('subscribers'),
      scheduled_at:        scheduleAt,
      status:              'pending'
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, scheduled: true, postId: data.id })
  }

  // Products load
  const { data: products, error } = await supabase
    .from('products').select('*').in('id', productIds).eq('in_stock', true)
  if (error || !products?.length) return res.status(404).json({ error: 'Products not found' })

  const results = []

  // ── শুধু Channel এ post করো ─────────────────────────────
  const r = await sendToChat(CHANNEL_ID, products, title, footer)
  results.push({
    target: 'channel',
    ok:     r.ok,
    error:  r.description || null
  })

  // ── Subscribers কে আলাদাভাবে direct message (চাইলে) ─────
  if (targets.includes('subscribers')) {
    const { data: subs } = await supabase
      .from('subscribers').select('user_id').eq('subscribed', true)
    let count = 0
    for (const sub of (subs || [])) {
      const text = buildText(products, title, footer)
      await tg('sendMessage', { chat_id: sub.user_id, text, parse_mode: 'Markdown' })
      count++
      await new Promise(r => setTimeout(r, 50))
    }
    results.push({ target: 'subscribers', ok: true, count })
  }

  // Log
  await supabase.from('post_logs').insert({
    post_type: 'manual', targets: JSON.stringify(results.map(r => r.target)),
    product_count: products.length, results: JSON.stringify(results),
    posted_at: new Date().toISOString()
  })

  const waText = encodeURIComponent(
    products.slice(0, 3).map(p => {
      const d = parseFloat(p.discount_amount) || 0
      return `${p.name} - ৳${p.price}${d > 0 ? ` (৳${d} ছাড়!)` : ''}`
    }).join('\n') + '\n\n🤖 https://t.me/DarazDealBD_bot'
  )

  const okCount = results.filter(r => r.ok).length
  return res.status(200).json({
    ok: true,
    scheduled: false,
    results,
    okCount,
    waShareUrl: `https://wa.me/?text=${waText}`,
    fbShareUrl: `https://www.facebook.com/sharer/sharer.php?u=https://t.me/DarazDealBD_bot`
  })
}
