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

  // Already a customer with this name? Don't make a duplicate.
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
  if (phoneF && c.phone) cfv[phoneF.id] = c.phone
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

module.exports = { whoAmI, addCustomer }
