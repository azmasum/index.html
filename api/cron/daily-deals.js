// api/cron/daily-deals.js
// Vercel Cron Job — প্রতিদিন সকাল ১০টায় চলবে
// Vercel Dashboard → Settings → Cron Jobs এ set করুন

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
)

const TOKEN          = process.env.TG_BOT_TOKEN
const CHANNEL_ID     = process.env.TG_CHANNEL_ID    // @darazme
const GROUP_ID       = process.env.TG_GROUP_ID      // @DarazDealBDBD
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

// ── Format Deal Post ──────────────────────────────────────────
function formatDealPost(products, type = 'daily') {
  const today = new Date().toLocaleDateString('bn-BD', {
    weekday: 'long', day: 'numeric', month: 'long'
  })

  const titles = {
    daily:   `🔥 *আজকের সেরা ডিল — ${today}*`,
    flash:   `⚡ *Flash Sale Alert!*`,
    weekly:  `📅 *সাপ্তাহিক সেরা অফার*`,
    custom:  `🛍️ *বিশেষ অফার!*`
  }

  let text = titles[type] + '\n' + '═'.repeat(28) + '\n\n'

  products.forEach((p, i) => {
    const orig = parseFloat(p.original_price) || 0
    const curr = parseFloat(p.price) || 0
    const saved = orig > curr ? orig - curr : 0
    const pct   = orig > 0 ? Math.round((saved / orig) * 100) : 0

    text += `${i + 1}️⃣ *${p.name}*\n`
    if (saved > 0) {
      text += `   ~~৳${orig.toLocaleString()}~~ → *৳${curr.toLocaleString()}*\n`
      text += `   🔥 ৳${saved.toLocaleString()} ছাড় (${pct}% OFF)\n`
    } else {
      text += `   💰 মাত্র *৳${curr.toLocaleString()}*\n`
    }
    text += '\n'
  })

  text += '═'.repeat(28) + '\n'
  text += `🤖 আরো deals পেতে:\n`
  text += `👉 @DarazDealBD_bot\n\n`
  text += `#DarazBD #BestDeal #ডিসকাউন্ট #অনলাইনশপিং`

  return text
}

// ── Send to Channel/Group ─────────────────────────────────────
async function postToTarget(targetId, products, type, platform) {
  if (!targetId) return { ok: false, reason: 'No target ID' }

  const text = formatDealPost(products, type)

  // First product এর image দিয়ে post করো
  const firstWithImage = products.find(p => p.image_url)

  // Individual product buttons
  const buttons = products.slice(0, 5).map(p => ([{
    text: `🛒 ${p.name.substring(0, 30)}...`,
    url:  affLink(p.daraz_link, platform)
  }]))

  buttons.push([{
    text: '🤖 Bot থেকে আরো দেখুন',
    url:  'https://t.me/DarazDealBD_bot'
  }])

  const keyboard = { inline_keyboard: buttons }

  try {
    if (firstWithImage) {
      const result = await tg('sendPhoto', {
        chat_id:      targetId,
        photo:        firstWithImage.image_url,
        caption:      text,
        parse_mode:   'Markdown',
        reply_markup: keyboard
      })
      return result
    } else {
      const result = await tg('sendMessage', {
        chat_id:      targetId,
        text:         text,
        parse_mode:   'Markdown',
        reply_markup: keyboard
      })
      return result
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ── Get Scheduled Posts ───────────────────────────────────────
async function getScheduledPosts() {
  const now = new Date()
  const { data } = await supabase
    .from('scheduled_posts')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(10)
  return data || []
}

// ── Mark Post as Sent ─────────────────────────────────────────
async function markSent(postId, results) {
  await supabase
    .from('scheduled_posts')
    .update({
      status:  'sent',
      sent_at: new Date().toISOString(),
      results: JSON.stringify(results)
    })
    .eq('id', postId)
}

// ── Log Auto Post ─────────────────────────────────────────────
async function logPost(type, targets, productCount, results) {
  await supabase.from('post_logs').insert({
    post_type:     type,
    targets:       JSON.stringify(targets),
    product_count: productCount,
    results:       JSON.stringify(results),
    posted_at:     new Date().toISOString()
  })
}

// ── MAIN HANDLER ──────────────────────────────────────────────
module.exports = async function handler(req, res) {

  // Security check — Vercel Cron secret
  const authHeader = req.headers['authorization']
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const results = []
  let totalPosted = 0

  try {

    // ── 1. Scheduled Posts প্রথমে process করো ──────────────
    const scheduledPosts = await getScheduledPosts()

    for (const post of scheduledPosts) {
      const productIds = JSON.parse(post.product_ids || '[]')

      const { data: products } = await supabase
        .from('products')
        .select('*')
        .in('id', productIds)
        .eq('in_stock', true)

      if (!products?.length) continue

      const postResults = []

      // Telegram Channel
      if (post.send_to_channel && CHANNEL_ID) {
        const r = await postToTarget(CHANNEL_ID, products, post.post_type || 'custom', 'channel')
        postResults.push({ target: 'channel', ok: r.ok })
      }

      // Telegram Group
      if (post.send_to_group && GROUP_ID) {
        const r = await postToTarget(GROUP_ID, products, post.post_type || 'custom', 'group')
        postResults.push({ target: 'group', ok: r.ok })
      }

      // Subscribers (Bot)
      if (post.send_to_subscribers) {
        const { data: subs } = await supabase
          .from('subscribers')
          .select('user_id')
          .eq('subscribed', true)

        let subCount = 0
        for (const sub of (subs || [])) {
          const text = formatDealPost(products, post.post_type || 'custom')
          await tg('sendMessage', {
            chat_id:    sub.user_id,
            text:       text,
            parse_mode: 'Markdown'
          })
          subCount++
          await new Promise(r => setTimeout(r, 50))
        }
        postResults.push({ target: 'subscribers', count: subCount })
      }

      await markSent(post.id, postResults)
      results.push({ scheduled: true, postId: post.id, results: postResults })
      totalPosted++
    }

    // ── 2. Daily Auto Deal (প্রতিদিন সকাল ১০টা) ───────────
    const isDailyRun = req.query.type === 'daily' || !req.query.type

    if (isDailyRun) {
      const { data: topDeals } = await supabase
        .from('products')
        .select('*')
        .eq('in_stock', true)
        .gt('discount_amount', 0)
        .order('discount_amount', { ascending: false })
        .limit(5)

      if (topDeals?.length) {
        const dailyResults = []

        // Channel এ post
        if (CHANNEL_ID) {
          const r = await postToTarget(CHANNEL_ID, topDeals, 'daily', 'channel')
          dailyResults.push({ target: '@darazme', ok: r.ok })
        }

        // Group এ post
        if (GROUP_ID) {
          const r = await postToTarget(GROUP_ID, topDeals, 'daily', 'group')
          dailyResults.push({ target: '@DarazDealBDBD', ok: r.ok })
        }

        // Subscribers এ পাঠাও
        const { data: subs } = await supabase
          .from('subscribers')
          .select('user_id')
          .eq('subscribed', true)

        let subCount = 0
        for (const sub of (subs || [])) {
          const text =
            `🌅 *সুপ্রভাত! আজকের সেরা ডিল:*\n\n` +
            topDeals.slice(0, 3).map((p, i) => {
              const d = parseFloat(p.discount_amount) || 0
              const pct = parseFloat(p.discount_percent) || 0
              return `${i+1}. *${p.name}*\n   ৳${p.price} | 🔥${pct}% ছাড়`
            }).join('\n\n') +
            `\n\n👉 /deals দিয়ে সব দেখুন`

          await tg('sendMessage', {
            chat_id:    sub.user_id,
            text:       text,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[
              { text: '🔥 সব deals দেখুন', url: 'https://t.me/DarazDealBD_bot' }
            ]]}
          })
          subCount++
          await new Promise(r => setTimeout(r, 50))
        }

        dailyResults.push({ target: 'subscribers', count: subCount })

        await logPost('daily', ['channel', 'group', 'subscribers'], topDeals.length, dailyResults)

        // Admin কে notify করো
        if (ADMIN_CHAT_ID) {
          await tg('sendMessage', {
            chat_id: ADMIN_CHAT_ID,
            text: `✅ *Daily Deal Auto-Post সফল!*\n\n` +
                  `📦 পণ্য: ${topDeals.length}টি\n` +
                  `📢 Channel: ${dailyResults.find(r=>r.target==='@darazme')?.ok ? '✅' : '❌'}\n` +
                  `👥 Group: ${dailyResults.find(r=>r.target==='@DarazDealBDBD')?.ok ? '✅' : '❌'}\n` +
                  `🔔 Subscribers: ${subCount}জন`,
            parse_mode: 'Markdown'
          })
        }

        results.push({ type: 'daily', results: dailyResults })
        totalPosted++
      }
    }

    return res.status(200).json({
      ok:          true,
      totalPosted,
      results,
      timestamp:   new Date().toISOString()
    })

  } catch (err) {
    console.error('Cron error:', err)
    return res.status(500).json({ ok: false, error: err.message })
  }
}
