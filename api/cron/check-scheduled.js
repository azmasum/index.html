const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
)

const TOKEN      = process.env.TG_BOT_TOKEN
const CHANNEL_ID = '-1002210302760'
const GROUP_ID   = '-1004320220003'

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.json()
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
    url:  p.daraz_link || 'https://www.daraz.com.bd'
  }]))
  buttons.push([{ text: '🤖 Bot এ আরো দেখুন', url: 'https://t.me/DarazDealBD_bot' }])

  const firstImg = products.find(p => p.image_url)
  if (firstImg) {
    return tg('sendPhoto', {
      chat_id: chatId, photo: firstImg.image_url,
      caption: text, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    })
  }
  return tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  })
}

module.exports = async function handler(req, res) {
  // Security check
  const auth = req.headers['authorization']
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const now = new Date().toISOString()

  // Pending scheduled posts খুঁজুন
  const { data: posts, error } = await supabase
    .from('scheduled_posts')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(10)

  if (error) return res.status(500).json({ error: error.message })
  if (!posts?.length) return res.status(200).json({ ok: true, processed: 0, message: 'No pending posts' })

  const results = []

  for (const post of posts) {
    const productIds = JSON.parse(post.product_ids || '[]')

    const { data: products } = await supabase
      .from('products')
      .select('*')
      .in('id', productIds)
      .eq('in_stock', true)

    if (!products?.length) {
      await supabase.from('scheduled_posts')
        .update({ status: 'failed', sent_at: now })
        .eq('id', post.id)
      continue
    }

    const postResults = []

    // Channel
    if (post.send_to_channel) {
      const r = await sendToChat(CHANNEL_ID, products, post.title, post.footer)
      postResults.push({ target: 'channel', ok: r.ok })
    }

    // Group
    if (post.send_to_group) {
      const r = await sendToChat(GROUP_ID, products, post.title, post.footer)
      postResults.push({ target: 'group', ok: r.ok })
    }

    // Subscribers
    if (post.send_to_subscribers) {
      const { data: subs } = await supabase
        .from('subscribers')
        .select('user_id')
        .eq('subscribed', true)

      let count = 0
      for (const sub of (subs || [])) {
        const text = buildText(products, post.title, post.footer)
        await tg('sendMessage', { chat_id: sub.user_id, text, parse_mode: 'Markdown' })
        count++
        await new Promise(r => setTimeout(r, 50))
      }
      postResults.push({ target: 'subscribers', count })
    }

    // Mark as sent
    await supabase.from('scheduled_posts')
      .update({
        status:   'sent',
        sent_at:  now,
        results:  JSON.stringify(postResults)
      })
      .eq('id', post.id)

    // Log
    await supabase.from('post_logs').insert({
      post_type:     post.post_type || 'scheduled',
      targets:       JSON.stringify(['channel', 'group']),
      product_count: products.length,
      results:       JSON.stringify(postResults),
      posted_at:     now
    })

    // Admin notify
    if (process.env.TG_ADMIN_CHAT_ID) {
      const okCount = postResults.filter(r => r.ok).length
      await tg('sendMessage', {
        chat_id:    process.env.TG_ADMIN_CHAT_ID,
        text:       `📅 *Scheduled Post Sent!*\n\n📦 পণ্য: ${products.length}টি\n✅ Platforms: ${okCount}টি\n🕐 ${new Date(post.scheduled_at).toLocaleString('bn-BD')}`,
        parse_mode: 'Markdown'
      })
    }

    results.push({ postId: post.id, results: postResults })
  }

  return res.status(200).json({
    ok:        true,
    processed: results.length,
    results
  })
}
