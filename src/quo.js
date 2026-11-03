// Quo (formerly OpenPhone) public API: send a text from one of your Quo numbers.
// Docs: https://www.quo.com/docs  (Authorization header is the raw API key, no "Bearer")
const { net } = require('electron')
const API = process.env.MULTISPACE_TEST_QUO_API || 'https://api.quo.com/v1'

async function call(key, method, path, body) {
  const res = await net.fetch(API + path, {
    method,
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  if (!res.ok) {
    const msg = (data && (data.message || data.error || (data.errors && data.errors[0] && data.errors[0].message))) || text.slice(0, 200) || `HTTP ${res.status}`
    if (res.status === 401 || res.status === 403) throw new Error('Quo did not accept the API key. Make one in Quo: Settings → API → Generate API key.')
    if (/a2p/i.test(msg)) throw new Error('Quo: this number is not approved for texting yet (A2P registration).')
    throw new Error('Quo: ' + msg)
  }
  return data
}

async function numbers(key) {
  const d = await call(key, 'GET', '/phone-numbers')
  return ((d && d.data) || []).map((n) => ({ id: n.id, number: n.number, label: `${n.name || 'Quo'} · ${n.formattedNumber || n.number}` }))
}

// to: phone in any format; from: PN… id or E.164
async function send(key, { from, to, content }) {
  const d = String(to || '').replace(/\D/g, '')
  const e164 = d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : '+' + d
  if (d.length < 10) throw new Error('No valid phone number to text.')
  if (!from) throw new Error('Pick which Quo number to send from (Tasks → Settings · Connections).')
  await call(key, 'POST', '/messages', { content: String(content).slice(0, 1600), from, to: [e164] })
  return true
}

module.exports = { numbers, send }
