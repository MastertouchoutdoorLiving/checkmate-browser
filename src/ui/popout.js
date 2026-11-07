const p = window.popout
document.body.classList.add(p.platform)
const $ = (s) => document.querySelector(s)
let focused = false
p.onState((s) => {
  $('#back').disabled = !s.canGoBack
  $('#forward').disabled = !s.canGoForward
  $('#reload').textContent = s.loading ? '✕' : '⟳'
  if (!focused) $('#address').value = s.url || ''
  $('#zoom').textContent = (s.zoom || 100) + '%'
  $('#zoom').classList.toggle('off', (s.zoom || 100) !== 100)
  document.title = s.title || 'CheckMate'
})
$('#back').onclick = p.back
$('#forward').onclick = p.forward
$('#reload').onclick = p.reload
$('#zoom').onclick = p.zoomReset
$('#home').onclick = p.home
$('#address').addEventListener('focus', () => { focused = true; setTimeout(() => $('#address').select(), 0) })
$('#address').addEventListener('blur', () => { focused = false })
$('#form').addEventListener('submit', (e) => { e.preventDefault(); p.go($('#address').value); $('#address').blur() })
p.ready()
