// Creates a customer in JobTread (account + contact + job location) from a saved contact.
// Uses JobTread's Pave API with a grant key the user pastes once (stored encrypted).
const { net } = require('electron')

const API = process.env.MULTISPACE_TEST_JOBTREAD_API || 'https://api.jobtread.com/pave'

async function pave(grantKey, query) {
  const res = await net.fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { $: { grantKey }, ...query } }),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  if (!res.ok || !data) {
    const msg = (data && (data.message || data.error)) || text.slice(0, 200) || `HTTP ${res.status}`
    throw new Error(res.status === 401 || /grant|unauthor/i.test(msg) ? 'JobTread did not accept the grant key. Make a new one at app.jobtread.com/grants and paste it again.' : 'JobTread: ' + msg)
  }
  return data
}

async function whoAmI(grantKey) {
  const d = await pave(grantKey, { currentGrant: { organization: { id: {}, name: {} } } })
  const org = d.currentGrant && d.currentGrant.organization
  if (!org || !org.id) throw new Error('This grant key has no JobTread company.')
  return org
}

async function addCustomer(grantKey, c) {
  const d = await pave(grantKey, {
    currentGrant: {
      organization: {
        id: {},
        customFields: { $: { size: 100, where: ['targetType', 'customerContact'] }, nodes: { id: {}, name: {}, type: {} } },
      },
    },
  })
  const org = d.currentGrant && d.currentGrant.organization
  if (!org || !org.id) throw new Error('This grant key has no JobTread company.')
  const fields = (org.customFields && org.customFields.nodes) || []
  const emailF = fields.find((f) => f.type === 'emailAddress')
  const phoneF = fields.find((f) => f.type === 'phoneNumber')
  const notesF = fields.find((f) => /note/i.test(f.name) && f.type === 'text')

  const name = String(c.first || c.company || '').trim()
  if (!name) throw new Error('Enter a name first.')

  // Already a customer (same phone, email or name)? Don't make a duplicate.
  const dupe = await findCustomer(grantKey, { phone: c.phone, email: c.email, name }).catch(() => null)
  if (dupe) return { id: dupe.id, existing: true, url: dupe.url }
  const found = await pave(grantKey, {
    organization: { $: { id: org.id }, accounts: { $: { where: { and: [['type', 'customer'], ['name', name]] }, size: 1 }, nodes: { id: {} } } },
  })
  const existing = found.organization && found.organization.accounts && found.organization.accounts.nodes && found.organization.accounts.nodes[0]
  if (existing) return { id: existing.id, existing: true, url: `https://app.jobtread.com/customers/${existing.id}` }

  const acc = await pave(grantKey, {
    createAccount: { $: { organizationId: org.id, name, type: 'customer' }, createdAccount: { id: {} } },
  })
  const accountId = acc.createAccount && acc.createAccount.createdAccount && acc.createAccount.createdAccount.id
  if (!accountId) throw new Error('JobTread did not create the customer.')

  const cfv = {}
  if (emailF && c.email) cfv[emailF.id] = c.email
  if (phoneF && c.phone) cfv[phoneF.id] = e164(c.phone)
  if (notesF && c.note) cfv[notesF.id] = c.note
  const con = await pave(grantKey, {
    createContact: { $: { accountId, name, ...(c.company && c.first ? { title: c.company } : {}), customFieldValues: cfv }, createdContact: { id: {} } },
  })
  const contactId = con.createContact && con.createContact.createdContact && con.createContact.createdContact.id

  const address = [c.street, c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter((x) => x && String(x).trim()).join(', ')
  if (c.street && address) {
    await pave(grantKey, {
      createLocation: { $: { accountId, ...(contactId ? { contactId } : {}), name: c.street, address }, createdLocation: { id: {} } },
    })
  }
  return { id: accountId, existing: false, url: `https://app.jobtread.com/customers/${accountId}` }
}

// "+1 (786) 301-0328" -> "+17863010328" (how JobTread stores phone numbers)
function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d[0] === '1') return '+' + d
  return '+' + d
}

let orgCache = null
async function org(grantKey) {
  if (orgCache && orgCache.key === grantKey && Date.now() - orgCache.at < 3600e3) return orgCache.org
  const d = await pave(grantKey, {
    currentGrant: { organization: { id: {}, customFields: { $: { size: 100, where: ['targetType', 'customerContact'] }, nodes: { id: {}, name: {}, type: {} } } } },
  })
  const o = d.currentGrant && d.currentGrant.organization
  if (!o || !o.id) throw new Error('This grant key has no JobTread company.')
  orgCache = { key: grantKey, at: Date.now(), org: o }
  return o
}

const ACCOUNT_FIELDS = {
  id: {},
  name: {},
  contacts: { $: { size: 5 }, nodes: { name: {}, customFieldValues: { nodes: { value: {}, customField: { type: {} } } } } },
  locations: { $: { size: 5 }, nodes: { id: {}, address: {} } },
  jobs: {
    $: { size: 10, sortBy: [{ field: 'createdAt', order: 'desc' }] },
    nodes: { id: {}, name: {}, number: {}, closedOn: {}, customFieldValues: { $: { where: [['customField', 'name'], 'Job Status / Lead Stage'] }, nodes: { value: {} } } },
  },
}
function shapeAccount(a) {
  const vals = (a.contacts?.nodes || []).flatMap((c) => c.customFieldValues?.nodes || [])
  return {
    id: a.id,
    name: a.name,
    url: `https://app.jobtread.com/customers/${a.id}`,
    phone: (vals.find((v) => v.customField?.type === 'phoneNumber') || {}).value || '',
    email: (vals.find((v) => v.customField?.type === 'emailAddress') || {}).value || '',
    address: (a.locations?.nodes || [])[0]?.address || '',
    jobs: (a.jobs?.nodes || []).map((j) => ({
      id: j.id,
      name: j.name,
      number: j.number,
      closed: !!j.closedOn,
      status: (j.customFieldValues?.nodes || [])[0]?.value || '',
      url: `https://app.jobtread.com/jobs/${j.id}`,
    })),
  }
}

// Finds the customer by phone (best), then email, then exact name.
async function findCustomer(grantKey, { phone, email, name } = {}) {
  const o = await org(grantKey)
  const fields = o.customFields?.nodes || []
  const tryField = async (type, value) => {
    const f = fields.find((x) => x.type === type)
    if (!f || !value) return null
    const d = await pave(grantKey, {
      organization: {
        $: { id: o.id },
        contacts: {
          $: { size: 1, with: { cf: { _: 'customFieldValues', $: { where: { and: [[['customField', 'id'], f.id], ['value', 'like', value]] } } } }, where: [['cf', 'count'], '>', 0] },
          nodes: { account: ACCOUNT_FIELDS },
        },
      },
    })
    const a = d.organization?.contacts?.nodes?.[0]?.account
    return a ? shapeAccount(a) : null
  }
  const digits = String(phone || '').replace(/\D/g, '').slice(-10)
  let found = digits.length >= 7 ? await tryField('phoneNumber', `%${digits}%`) : null
  if (!found && email) found = await tryField('emailAddress', String(email).trim())
  if (!found && name && !/^[+\d(][\d\s()+\-.]*$/.test(name)) {
    const d = await pave(grantKey, {
      organization: { $: { id: o.id }, accounts: { $: { size: 1, where: { and: [['type', 'customer'], ['name', String(name).trim()]] } }, nodes: ACCOUNT_FIELDS } },
    })
    const a = d.organization?.accounts?.nodes?.[0]
    if (a) found = shapeAccount(a)
  }
  return found
}

// Uploads a picture (bytes) and files it on a job or customer.
async function uploadFile(grantKey, { targetType, targetId, name, mime, bytes }) {
  if (!['job', 'account'].includes(targetType)) throw new Error('Pick a job or customer.')
  const o = await org(grantKey)
  const buf = Buffer.from(bytes)
  if (!buf.length) throw new Error('The picture is empty.')
  if (buf.length > 50 * 1024 * 1024) throw new Error('The file is too big (over 50 MB).')
  const up = await pave(grantKey, {
    createUploadRequest: { $: { organizationId: o.id, size: buf.length, type: mime || { fromName: name } }, createdUploadRequest: { id: {}, url: {}, method: {}, headers: {} } },
  })
  const r = up.createUploadRequest?.createdUploadRequest
  if (!r || !r.url) throw new Error('JobTread did not accept the upload.')
  const put = await net.fetch(r.url, { method: r.method || 'PUT', headers: r.headers || {}, body: buf })
  if (!put.ok) throw new Error(`Upload failed (${put.status})`)
  await pave(grantKey, {
    createFile: { $: { targetType, targetId, name: name || 'Photo.jpg', uploadRequestId: r.id, folder: 'Photos' }, createdFile: { id: {} } },
  })
  return true
}

module.exports = { whoAmI, addCustomer, findCustomer, uploadFile, e164 }
