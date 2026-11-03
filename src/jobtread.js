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

// The company a grant key belongs to. Some keys are tied to the user rather than one company:
// then use the user's company (the first one, if they belong to several).
const ORG_CACHE = new Map()
async function orgOf(grantKey) {
  if (ORG_CACHE.has(grantKey)) return ORG_CACHE.get(grantKey)
  const d = await pave(grantKey, {
    currentGrant: { id: {}, organization: { id: {}, name: {} }, user: { memberships: { nodes: { organization: { id: {}, name: {} } } } } },
  })
  const g = d.currentGrant
  if (!g) throw new Error('JobTread did not accept this key. Copy the whole key again (it is long) and paste it with the Paste button.')
  const mem = ((g.user && g.user.memberships && g.user.memberships.nodes) || []).map((m) => m.organization).filter((o) => o && o.id)
  const org = (g.organization && g.organization.id && g.organization) || mem[0]
  if (!org) throw new Error('This key is not linked to a JobTread company. In JobTread, open app.jobtread.com/grants while signed in to your company and make a new key.')
  ORG_CACHE.set(grantKey, org)
  return org
}
async function whoAmI(grantKey) {
  return orgOf(grantKey)
}
async function customFields(grantKey, orgId) {
  const d = await pave(grantKey, {
    organization: { $: { id: orgId }, customFields: { $: { size: 100, where: ['targetType', 'customerContact'] }, nodes: { id: {}, name: {}, type: {} } } },
  })
  return (d.organization && d.organization.customFields && d.organization.customFields.nodes) || []
}

async function addCustomer(grantKey, c) {
  const org = await orgOf(grantKey)
  const fields = await customFields(grantKey, org.id)
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
  const base = await orgOf(grantKey)
  const o = { ...base, customFields: { nodes: await customFields(grantKey, base.id) } }
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
async function uploadFile(grantKey, { targetType, targetId, name, mime, bytes, folder }) {
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
    createFile: { $: { targetType, targetId, name: name || 'Photo.jpg', uploadRequestId: r.id, folder: folder || 'Photos' }, createdFile: { id: {} } },
  })
  return true
}

// A comment on a job (only your team sees it, not the customer).
async function addComment(grantKey, { jobId, message, name }) {
  if (!jobId) throw new Error('Pick a job first.')
  const text = String(message || '').trim().slice(0, 4096)
  if (!text) throw new Error('The message is empty.')
  const d = await pave(grantKey, {
    createComment: {
      $: { targetType: 'job', targetId: String(jobId), message: text, ...(name ? { name: String(name).slice(0, 128) } : {}), isVisibleToCustomerRoles: false, isVisibleToVendorRoles: false, isVisibleToInternalRoles: true },
      createdComment: { id: {} },
    },
  })
  return { id: d.createComment?.createdComment?.id || null, url: `https://app.jobtread.com/jobs/${jobId}` }
}

// A to-do on a job. due: "YYYY-MM-DD" or empty.
async function addTask(grantKey, { jobId, name, description, due }) {
  if (!jobId) throw new Error('Pick a job first.')
  const title = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!title) throw new Error('Give the task a name.')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(due || '')) ? String(due) : null
  const d = await pave(grantKey, {
    createTask: {
      $: { targetType: 'job', targetId: String(jobId), name: title, isToDo: true, ...(description ? { description: String(description).slice(0, 4096) } : {}), ...(date ? { startDate: date, endDate: date } : {}) },
      createdTask: { id: {} },
    },
  })
  return { id: d.createTask?.createdTask?.id || null, url: `https://app.jobtread.com/jobs/${jobId}` }
}

// Any job by name, number, customer or address (for supplier invoices and the like).
async function searchJobs(grantKey, q) {
  const o = await org(grantKey)
  q = String(q || '').trim().slice(0, 80)
  if (q.length < 2) return []
  const like = `%${q}%`
  const d = await pave(grantKey, {
    organization: {
      $: { id: o.id },
      jobs: {
        $: { size: 12, sortBy: [{ field: 'createdAt', order: 'desc' }], where: { or: [['name', 'like', like], ['number', 'like', like], [['location', 'account', 'name'], 'like', like], [['location', 'address'], 'like', like]] } },
        nodes: { id: {}, name: {}, number: {}, closedOn: {}, location: { address: {}, account: { id: {}, name: {} } } },
      },
    },
  })
  const jobs = (d.organization?.jobs?.nodes || []).map((j) => ({
    id: j.id, name: j.name, number: j.number, closed: !!j.closedOn,
    customer: j.location?.account?.name || '', accountId: j.location?.account?.id || '', address: j.location?.address || '',
    url: `https://app.jobtread.com/jobs/${j.id}`,
  }))
  return [...jobs.filter((j) => !j.closed), ...jobs.filter((j) => j.closed)]
}

// Your own membership in the company (to find tasks assigned to you)
const MEMBER_CACHE = new Map()
async function myMembership(grantKey) {
  if (MEMBER_CACHE.has(grantKey)) return MEMBER_CACHE.get(grantKey)
  const o = await org(grantKey)
  const d = await pave(grantKey, { currentGrant: { user: { id: {}, name: {}, memberships: { nodes: { id: {}, organization: { id: {} } } } } } })
  const u = d.currentGrant && d.currentGrant.user
  const m = u && (u.memberships?.nodes || []).find((x) => x.organization && x.organization.id === o.id)
  const r = m ? { id: m.id, name: u.name || '' } : null
  MEMBER_CACHE.set(grantKey, r)
  return r
}

// Open JobTread tasks and to-dos assigned to you, soonest first (no date last).
async function myTasks(grantKey) {
  const o = await org(grantKey)
  const me = await myMembership(grantKey)
  if (!me) return { me: null, tasks: [] }
  const d = await pave(grantKey, {
    organization: {
      $: { id: o.id },
      tasks: {
        $: {
          size: 100,
          with: { am: { _: 'assignedMemberships', $: { where: ['id', me.id] } } },
          where: { and: [[['am', 'count'], '>', 0], { or: [['progress', null], ['progress', '<', 1]] }] },
          sortBy: [{ field: 'endDate' }],
        },
        nodes: { id: {}, name: {}, startDate: {}, endDate: {}, isToDo: {}, progress: {}, job: { id: {}, name: {}, number: {} } },
      },
    },
  })
  const tasks = (d.organization?.tasks?.nodes || []).map((t) => ({
    id: t.id, name: t.name, due: t.endDate || t.startDate || null, todo: !!t.isToDo, progress: t.progress,
    job: t.job ? { id: t.job.id, name: t.job.name, number: t.job.number } : null,
    url: t.job ? `https://app.jobtread.com/jobs/${t.job.id}/schedule` : 'https://app.jobtread.com/to-dos',
  }))
  tasks.sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0)
  return { me, tasks }
}
async function completeTask(grantKey, id) {
  await pave(grantKey, { updateTask: { $: { id: String(id), progress: 1 } } })
  return true
}

// Quick search: customers by name / phone / email, and jobs.
async function searchAll(grantKey, q) {
  q = String(q || '').trim().slice(0, 80)
  if (q.length < 2) return { customers: [], jobs: [] }
  const o = await org(grantKey)
  const digits = q.replace(/\D/g, '')
  const tasks = [searchJobs(grantKey, q).catch(() => [])]
  if (digits.length >= 7 && digits.length >= q.replace(/[\s()+.-]/g, '').length) tasks.push(findCustomer(grantKey, { phone: q }).then((c) => (c ? [c] : [])).catch(() => []))
  else if (/@/.test(q)) tasks.push(findCustomer(grantKey, { email: q }).then((c) => (c ? [c] : [])).catch(() => []))
  else
    tasks.push(
      pave(grantKey, {
        organization: { $: { id: o.id }, accounts: { $: { size: 8, where: { and: [['type', 'customer'], ['name', 'like', `%${q}%`]] }, sortBy: [{ field: 'createdAt', order: 'desc' }] }, nodes: ACCOUNT_FIELDS } },
      }).then((d) => (d.organization?.accounts?.nodes || []).map(shapeAccount)).catch(() => [])
    )
  const [jobs, customers] = await Promise.all(tasks)
  return { customers, jobs }
}

// Money to chase: estimates sent but not approved yet, and invoices past due.
const isoDay = (d) => d.toISOString().slice(0, 10)
async function moneyToChase(grantKey, { minDays = 3, maxDays = 30 } = {}) {
  const o = await org(grantKey)
  const now = Date.now()
  const from = isoDay(new Date(now - maxDays * 864e5)), to = isoDay(new Date(now - minDays * 864e5)), today = isoDay(new Date(now))
  const DOC = { id: {}, name: {}, number: {}, issueDate: {}, dueDate: {}, priceWithTax: {}, balance: {}, toName: {}, toPhoneNumber: {}, toEmailAddress: {}, job: { id: {}, name: {}, number: {} }, account: { id: {}, name: {} } }
  const d = await pave(grantKey, {
    organization: {
      $: { id: o.id },
      est: { _: 'documents', $: { size: 60, where: { and: [['type', 'customerOrder'], ['status', 'pending'], ['priceWithTax', '>', 0], ['issueDate', '>=', from], ['issueDate', '<=', to]] }, sortBy: [{ field: 'issueDate', order: 'desc' }] }, nodes: DOC },
      inv: { _: 'documents', $: { size: 60, where: { and: [['type', 'customerInvoice'], ['status', 'pending'], ['balance', '>', 0], ['dueDate', '<', today]] }, sortBy: [{ field: 'dueDate', order: 'desc' }] }, count: {}, sum: { $: 'balance' }, nodes: DOC },
    },
  })
  const shape = (x, kind) => ({
    id: x.id, kind, name: x.name, number: x.number,
    customer: x.toName || x.account?.name || '', phone: x.toPhoneNumber || '', email: x.toEmailAddress || '',
    amount: kind === 'invoice' ? x.balance : x.priceWithTax,
    date: kind === 'invoice' ? x.dueDate : x.issueDate,
    days: Math.max(0, Math.floor((now - new Date((kind === 'invoice' ? x.dueDate : x.issueDate) + 'T12:00').getTime()) / 864e5)),
    job: x.job ? { id: x.job.id, name: x.job.name, number: x.job.number } : null,
    url: x.job ? `https://app.jobtread.com/jobs/${x.job.id}/documents/${x.id}` : 'https://app.jobtread.com/documents',
  })
  return {
    estimates: (d.organization?.est?.nodes || []).map((x) => shape(x, 'estimate')),
    invoices: (d.organization?.inv?.nodes || []).map((x) => shape(x, 'invoice')),
    invoiceCount: d.organization?.inv?.count || 0,
    invoiceTotal: d.organization?.inv?.sum || 0,
  }
}

module.exports = { moneyToChase, whoAmI, addCustomer, findCustomer, uploadFile, addComment, addTask, searchJobs, myTasks, completeTask, searchAll, e164 }
