// api/cron/daily-deals.js
// একটাই Cron Job — Daily Auto Post + Scheduled Posts Check
// Vercel Hobby Plan এ দিনে ১ বার চলে (সকাল ১০টা BD time)

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
)

const TOKEN          = process.env.TG_BOT_TOKEN
const CHANNEL_ID     = '-1002210302760'
const GROUP_ID       = '-1004320220003'
const ADMIN_CHAT_ID  = process.env.TG_ADMIN_CHAT_ID

// ── Telegram API ──────────────────────────────────────────────
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  })
  return res.json()
}

// ── Affiliate Link ────────────────────────────────────────────
function affLink(url, platform) {
  try {
    if (!url || !url.startsWith('http')) return 'https://www.daraz.com.bd'
    const u = new URL(url)
    u.searchParams.set('sub_aff_id', process.env.DARAZ_AFF_ID || '')
    u.searchParams.set('sub_id1', 'txn_' + Date.now())
    u.searchParams.set('sub_id2', platform)
    u.searchParams.set('sub_id3', 'daily_deal')
    u.searchParams.set('sub_id5', new Date().toISOString().split('T')[0])
    return u.toString()
  } catch { return 'https://www.daraz.com.bd' }
}

// ── Build Post Text ───────────────────────────────────────────
function buildText(products, title, footer) {
  let text = `${title || '🔥 *আজকের সেরা ডিল*'}\n${'═'.repeat(28)}\n\n`
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
  text += footer || `🤖 আরো deals: @DarazDealBD_bot\n#DarazBD #BestDeal`
  return text
}

// ── Send to Chat ──────────────────────────────────────────────
async function sendToChat(chatId, products, title, footer, platform = 'channel') {
  const text    = buildText(products, title, footer)
  const buttons = products.slice(0, 8).map(p => ([{
    text: `🛒 ${p.name.substring(0, 30)}`,
    url:  affLink(p.daraz_link, platform)
  }]))
  buttons.push([{ text: '🤖 Bot এ আরো দেখুন', url: 'https://t.me/DarazDealBD_bot' }])

  const firstImg = products.find(p => p.image_url)
  try {
    if (firstImg) {
      return await tg('sendPhoto', {
        chat_id: chatId, photo: firstImg.image_url,
        caption: text, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      })
    }
    return await tg('sendMessage', {
      chat_id: chatId, text, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    })
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ════════════════════════════════════════════════════════════
// PART 1: PROCESS SCHEDULED POSTS (সময় হয়ে গেছে এমন posts)
// ════════════════════════════════════════════════════════════
async function processScheduledPosts() {
  const now = new Date().toISOString()
  const results = []

  const { data: posts } = await supabase
    .from('scheduled_posts')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(20)

  if (!posts?.length) return { processed: 0, results: [] }

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

    if (post.send_to_channel) {
      const r = await sendToChat(CHANNEL_ID, products, post.title, post.footer, 'channel')
      postResults.push({ target: 'channel', ok: r.ok })
    }

    if (post.send_to_group) {
      const r = await sendToChat(GROUP_ID, products, post.title, post.footer, 'group')
      postResults.push({ target: 'group', ok: r.ok })
    }

    if (post.send_to_subscribers) {
      const { data: subs } = await supabase
        .from('subscribers').select('user_id').eq('subscribed', true)
      let count = 0
      for (const sub of (subs || [])) {
        const text = buildText(products, post.title, post.footer)
        await tg('sendMessage', { chat_id: sub.user_id, text, parse_mode: 'Markdown' })
        count++
        await new Promise(r => setTimeout(r, 50))
      }
      postResults.push({ target: 'subscribers', count })
    }

    await supabase.from('scheduled_posts')
      .update({ status: 'sent', sent_at: now, results: JSON.stringify(postResults) })
      .eq('id', post.id)

    await supabase.from('post_logs').insert({
      post_type:     post.post_type || 'scheduled',
      targets:       JSON.stringify(postResults.map(r => r.target)),
      product_count: products.length,
      results:       JSON.stringify(postResults),
      posted_at:     now
    })

    results.push({ postId: post.id, results: postResults })
  }

  return { processed: results.length, results }
}

// ════════════════════════════════════════════════════════════
// PART 2: DAILY AUTO DEAL POST (প্রতিদিনের default post)
// ════════════════════════════════════════════════════════════
async function sendDailyDeals() {
  const { data: topDeals } = await supabase
    .from('products')
    .select('*')
    .eq('in_stock', true)
    .gt('discount_amount', 0)
    .order('discount_amount', { ascending: false })
    .limit(5)

  if (!topDeals?.length) return { sent: false, reason: 'no deals' }

  const dailyResults = []

  if (CHANNEL_ID) {
    const r = await sendToChat(CHANNEL_ID, topDeals, null, null, 'channel')
    dailyResults.push({ target: 'channel', ok: r.ok })
  }

  if (GROUP_ID) {
    const r = await sendToChat(GROUP_ID, topDeals, null, null, 'group')
    dailyResults.push({ target: 'group', ok: r.ok })
  }

  const { data: subs } = await supabase
    .from('subscribers').select('user_id').eq('subscribed', true)

  let subCount = 0
  for (const sub of (subs || [])) {
    const text =
      `🌅 *সুপ্রভাত! আজকের সেরা ডিল:*\n\n` +
      topDeals.slice(0, 3).map((p, i) => {
        const pct = parseFloat(p.discount_percent) || 0
        return `${i+1}. *${p.name}*\n   ৳${p.price} | 🔥${pct}% ছাড়`
      }).join('\n\n') +
      `\n\n👉 /deals দিয়ে সব দেখুন`

    await tg('sendMessage', {
      chat_id: sub.user_id, text, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '🔥 সব deals দেখুন', url: 'https://t.me/DarazDealBD_bot' }
      ]]}
    })
    subCount++
    await new Promise(r => setTimeout(r, 50))
  }

  dailyResults.push({ target: 'subscribers', count: subCount })

  await supabase.from('post_logs').insert({
    post_type:     'daily',
    targets:       JSON.stringify(['channel', 'group', 'subscribers']),
    product_count: topDeals.length,
    results:       JSON.stringify(dailyResults),
    posted_at:     new Date().toISOString()
  })

  return { sent: true, results: dailyResults, count: topDeals.length }
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {

  // Security check (Vercel Cron বা Manual test দুটোতেই কাজ করবে)
  const authHeader = req.headers['authorization']
  const isVercelCron = req.headers['x-vercel-cron'] === '1' // Vercel Cron auto header
  const isManualAuth = authHeader === `Bearer ${process.env.CRON_SECRET}`

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // ── Step 1: প্রথমে Scheduled Posts process করো ──────────
    const scheduledResult = await processScheduledPosts()

    // ── Step 2: তারপর Daily Deal পাঠাও (যদি ?type=daily বা cron auto trigger) ──
    let dailyResult = { sent: false, reason: 'skipped' }
    const shouldSendDaily = req.query.type === 'daily' || isVercelCron

    if (shouldSendDaily) {
      dailyResult = await sendDailyDeals()
    }

    // Admin notify
    if (ADMIN_CHAT_ID && (scheduledResult.processed > 0 || dailyResult.sent)) {
      await tg('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text: `✅ *Cron Job সম্পন্ন!*\n\n` +
              `📅 Scheduled Posts: ${scheduledResult.processed}টি\n` +
              `🌅 Daily Deal: ${dailyResult.sent ? `✅ ${dailyResult.count}টি পণ্য` : '⏭️ skip'}\n` +
              `🕐 ${new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' })}`,
        parse_mode: 'Markdown'
      }).catch(() => {})
    }

    return res.status(200).json({
      ok:        true,
      scheduled: scheduledResult,
      daily:     dailyResult,
      timestamp: new Date().toISOString()
    })

  } catch (err) {
    console.error('Cron error:', err)
    return res.status(500).json({ ok: false, error: err.message })
  }
}
