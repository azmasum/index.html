// api/post/send.js
// Admin Panel থেকে manual post trigger করার জন্য

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
)

const TOKEN      = process.env.TG_BOT_TOKEN
const CHANNEL_ID = '@darazme'
const GROUP_ID   = '@DarazDealBDBD'

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

function buildPostText(products, title, footer) {
  let text = `${title}\n${'═'.repeat(28)}\n\n`

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    productIds,
    title       = '🔥 *বিশেষ অফার!*',
    footer,
    targets     = ['channel', 'group'],
    scheduleAt  = null,   // null = এখনই পাঠাও
    postType    = 'custom'
  } = req.body

  if (!productIds?.length) return res.status(400).json({ error: 'No products selected' })

  // Schedule হলে DB তে save করো
  if (scheduleAt) {
    const { data, error } = await supabase.from('scheduled_posts').insert({
      product_ids:        JSON.stringify(productIds),
      title,
      footer,
      post_type:          postType,
      send_to_channel:    targets.includes('channel'),
      send_to_group:      targets.includes('group'),
      send_to_subscribers:targets.includes('subscribers'),
      scheduled_at:       scheduleAt,
      status:             'pending'
    }).select().single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, scheduled: true, postId: data.id, scheduledAt: scheduleAt })
  }

  // এখনই পাঠাও
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .in('id', productIds)
    .eq('in_stock', true)

  if (!products?.length) return res.status(404).json({ error: 'Products not found' })

  const text    = buildPostText(products, title, footer)
  const buttons = products.map(p => ([{
    text: `🛒 ${p.name.substring(0, 25)}`,
    url:  affLink(p.daraz_link, 'post')
  }]))
  buttons.push([{ text: '🤖 Bot এ আরো দেখুন', url: 'https://t.me/DarazDealBD_bot' }])
  const keyboard = { inline_keyboard: buttons }

  const results = []
  const firstImg = products.find(p => p.image_url)

  for (const target of targets) {
    const chatId = target === 'channel' ? CHANNEL_ID
                 : target === 'group'   ? GROUP_ID
                 : target // custom chat_id

    try {
      let r
      if (firstImg) {
        r = await tg('sendPhoto', {
          chat_id: chatId, photo: firstImg.image_url,
          caption: text, parse_mode: 'Markdown', reply_markup: keyboard
        })
      } else {
        r = await tg('sendMessage', {
          chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: keyboard
        })
      }

      // WhatsApp share URL generate করো
      const waText = encodeURIComponent(
        products.slice(0, 3).map(p => {
          const d = parseFloat(p.discount_amount) || 0
          return `${p.name} - ৳${p.price}${d > 0 ? ` (৳${d} ছাড়!)` : ''}\n${affLink(p.daraz_link, 'whatsapp')}`
        }).join('\n\n') + '\n\n🤖 আরো deals: https://t.me/DarazDealBD_bot'
      )

      results.push({
        target,
        ok:        r.ok,
        messageId: r.result?.message_id,
        waShareUrl:`https://wa.me/?text=${waText}`,
        fbShareUrl:`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent('https://t.me/DarazDealBD_bot')}`
      })
    } catch (err) {
      results.push({ target, ok: false, error: err.message })
    }
  }

  // Log করো
  await supabase.from('post_logs').insert({
    post_type:     postType,
    targets:       JSON.stringify(targets),
    product_count: products.length,
    results:       JSON.stringify(results),
    posted_at:     new Date().toISOString()
  })

  return res.status(200).json({ ok: true, scheduled: false, results })
}
