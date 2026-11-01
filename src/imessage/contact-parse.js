// Finds contact details (name, email, street address) in text messages someone sent you.
;(function (root) {
  const SUFFIX =
    'street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl|terrace|ter|circle|cir|parkway|pkwy|highway|hwy|trail|trl|loop|path|row|square|sq|run|point|pt|cove|cv|crossing|xing|isle|key|pass|manor|mnr|glen|ridge|bend|walk|alley|plaza|plz'
  const STATES = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
    hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
    massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
    'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
    pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
    virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  }
  const ABBR = new Set(Object.values(STATES).concat('DC'))
  const stateRe = '(' + Object.keys(STATES).join('|') + '|[A-Za-z]{2})'
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
  // 20898 Hamaca Court, Boca Raton, FL 33433   /   12468 NW 19th place Coral Springs fl 33071
  const ADDRESS = new RegExp(
    '(\\d{1,6}\\s+(?:[NSEW]{1,2}\\.?\\s+)?[A-Za-z0-9.\' -]{1,40}?\\b(?:' + SUFFIX + ')\\b\\.?' +
      '(?:\\s*,?\\s*(?:apt|apartment|unit|suite|ste|#)\\.?\\s*[A-Za-z0-9-]+)?' +
      '(?:\\s+[NSEW]{1,2}\\b)?)' + // street
      '\\s*,?\\s*([A-Za-z][A-Za-z .\'-]{1,30}?)' + // city
      '\\s*,?\\s+' + stateRe + '\\.?' + // state
      '\\s*,?\\s*(\\d{5})(?:-\\d{4})?\\b',
    'i'
  )
  const title = (s) => s.replace(/\s+/g, ' ').trim().replace(/\b([a-z])([a-z']*)/gi, (m, a, b) => (m.length <= 2 && /^[NSEW]{1,2}$/i.test(m) ? m.toUpperCase() : a.toUpperCase() + b.toLowerCase()))
  const NOT_NAME = /^(hi|hello|hey|thanks|thank|yes|no|ok|okay|good|my|the|this|its|it's|address|email|name|phone|here|sure|please|sorry|dear|mr|mrs|ms|dr|me|at|to|is|for|send|call|text|you|your|our|us|and|or|from|at)$/i
  function nameFrom(text, before) {
    let m = text.match(/\b(?:my name is|name is|this is|i am|i'm|it's|it is)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2})/i)
    if (m) return m[1]
    // a short name right before the email/address: "Kasey Robbins kasey@... 123 Main St ..."
    if (before != null) {
      const words = before.replace(/[,:;-]+\s*$/, '').trim().split(/\s+/).filter(Boolean)
      const tail = words.slice(-3)
      // only Capitalized words count here, so "email me at" isn't taken for a name
      while (tail.length && (NOT_NAME.test(tail[0]) || !/^[A-Z][A-Za-z'.-]*$/.test(tail[0]))) tail.shift()
      if (tail.length >= 1 && tail.length <= 3 && tail.every((w) => /^[A-Z][A-Za-z'.-]*$/.test(w) && !NOT_NAME.test(w))) return tail.join(' ')
    }
    return ''
  }
  function parse(text) {
    const out = {}
    const t = String(text || '').replace(/\s+/g, ' ')
    const e = t.match(EMAIL)
    if (e) out.email = e[0].toLowerCase()
    const a = t.match(ADDRESS)
    if (a) {
      const st = a[3].toLowerCase()
      const abbr = STATES[st] || (ABBR.has(a[3].toUpperCase()) ? a[3].toUpperCase() : '')
      if (abbr) {
        out.street = title(a[1].replace(/\s*,\s*$/, ''))
        out.city = title(a[2])
        out.state = abbr
        out.zip = a[4]
      }
    }
    const firstHit = Math.min(e ? e.index : Infinity, a && out.street ? a.index : Infinity)
    const name = nameFrom(t, firstHit < Infinity ? t.slice(0, firstHit) : null)
    if (name) {
      const parts = title(name).split(' ')
      out.first = parts[0]
      out.last = parts.slice(1).join(' ')
    }
    return out
  }
  // Newest message first; each field comes from the newest message that has it.
  function fromMessages(texts) {
    const out = {}
    for (const t of texts) {
      const p = parse(t)
      if (!out.email && p.email) out.email = p.email
      if (!out.street && p.street) Object.assign(out, { street: p.street, city: p.city, state: p.state, zip: p.zip })
      if (!out.first && p.first) Object.assign(out, { first: p.first, last: p.last })
    }
    return out
  }
  const api = { parse, fromMessages }
  if (typeof module !== 'undefined') module.exports = api
  else root.contactParse = api
})(this)
