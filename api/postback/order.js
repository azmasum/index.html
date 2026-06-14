// api/postback/order.js
// Daraz থেকে D+1 এ sale data আসবে এখানে

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
)

const TOKEN         = process.env.TG_BOT_TOKEN
const ADMIN_CHAT_ID = process.env.TG_ADMIN_CHAT_ID

async function notifyAdmin(data) {
  if (!TOKEN || !ADMIN_CHAT_ID) return
  const msg =
    `🎉 *নতুন Sale!*\n` +
    `${'─'.repeat(26)}\n` +
    `💰 Payout: *৳${parseFloat(data.payout || 0).toLocaleString()}*\n` +
    `🛒 Order: ৳${parseFloat(data.pay_amount || 0).toLocaleString()}\n` +
    `📦 Category: ${data.category_l1 || '—'}\n` +
    `📱 Platform: ${data.platform || '—'}\n` +
    `📅 ${new Date().toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' })}`

  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    ADMIN_CHAT_ID,
      text:       msg,
      parse_mode: 'Markdown'
    })
  })
}

module.exports = async function handler(req, res) {
  const q = req.method === 'GET' ? req.query : req.body

  const {
    offer_id, pay_amount, payout,
    category_l1, device, channel,
    txn_id, platform, campaign, user_id, date
  } = q

  // Test value ignore
  if (!txn_id || txn_id.toLowerCase().includes('test')) {
    return res.status(200).json({ status: 'skip', msg: 'test value ignored' })
  }

  // Duplicate check
  const { data: existing } = await supabase
    .from('postback_orders')
    .select('id')
    .eq('txn_id', txn_id)
    .maybeSingle()

  if (existing) {
    return res.status(200).json({ status: 'duplicate' })
  }

  // Save
  const { error } = await supabase.from('postback_orders').insert({
    offer_id, pay_amount: parseFloat(pay_amount) || 0,
    payout: parseFloat(payout) || 0,
    category_l1, device_os: device,
    channel_id: channel, txn_id,
    platform, campaign, user_id,
    received_at: new Date().toISOString()
  })

  if (error) return res.status(500).json({ status: 'error', msg: error.message })

  // Notify admin
  await notifyAdmin({ payout, pay_amount, category_l1, platform })

  return res.status(200).json({ status: 'ok', txn_id })
}
