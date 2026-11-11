// Voice messages to text, on this Mac only (Apple's speech recognition, nothing is uploaded).
// It runs a tiny Swift script with the `swift` that comes with Apple's Command Line Tools / Xcode.
// Both English and Portuguese are tried and the more confident answer is kept.
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const SWIFT = `import Foundation
import Speech
let args = CommandLine.arguments
if args.count < 3 { print("ERR:usage"); exit(2) }
let url = URL(fileURLWithPath: args[1])
SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { print("ERR:NOAUTH"); exit(3) }
  guard let rec = SFSpeechRecognizer(locale: Locale(identifier: args[2])), rec.isAvailable else { print("ERR:UNAVAILABLE"); exit(4) }
  let req = SFSpeechURLRecognitionRequest(url: url)
  req.shouldReportPartialResults = false
  rec.recognitionTask(with: req) { result, error in
    if let r = result, r.isFinal {
      let segs = r.bestTranscription.segments
      let conf = segs.isEmpty ? 0 : segs.map { Double($0.confidence) }.reduce(0, +) / Double(segs.count)
      print("OK\\t\\(conf)\\t\\(r.bestTranscription.formattedString)")
      exit(0)
    }
    if let e = error { print("ERR:\\(e.localizedDescription)"); exit(5) }
  }
}
RunLoop.main.run()
`

let dir = null
const setDir = (d) => (dir = d)
const cacheFile = () => path.join(dir, 'transcripts.json')
function readCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) } catch { return {} }
}
function writeCache(c) {
  try { fs.writeFileSync(cacheFile(), JSON.stringify(c)) } catch {}
}

function runOne(script, file, locale) {
  return new Promise((resolve) => {
    execFile('/usr/bin/swift', [script, file, locale], { timeout: 120000, maxBuffer: 1 << 20 }, (err, out, errOut) => {
      const line = String(out || '').trim().split('\n').pop() || ''
      if (line.startsWith('OK\t')) {
        const [, conf, ...rest] = line.split('\t')
        return resolve({ conf: Number(conf) || 0, text: rest.join('\t').trim() })
      }
      resolve({ error: line.replace(/^ERR:/, '') || String((err && err.message) || errOut || 'failed') })
    })
  })
}

async function transcribe(id, file) {
  const cache = readCache()
  if (cache[id]) return cache[id]
  if (process.platform !== 'darwin') throw new Error('Voice message transcription works on a Mac only.')
  const script = path.join(dir, 'transcribe.swift')
  fs.writeFileSync(script, SWIFT)
  const results = await Promise.all(['en-US', 'pt-BR'].map((l) => runOne(script, file, l)))
  const good = results.filter((r) => r.text)
  if (!good.length) {
    const e = (results.find((r) => r.error) || {}).error || 'nothing recognised'
    if (/NOAUTH/.test(e)) throw new Error('Allow Speech Recognition for CheckMate Browser (System Settings → Privacy & Security → Speech Recognition), then try again.')
    if (/No such file|xcrun|developer tools|swift/i.test(e)) throw new Error('Needs Apple\'s Command Line Tools. In Terminal run: xcode-select --install')
    throw new Error('Could not transcribe this voice message (' + e.slice(0, 80) + ').')
  }
  good.sort((a, b) => b.conf - a.conf)
  cache[id] = good[0].text
  writeCache(cache)
  return cache[id]
}

module.exports = { transcribe, readCache, setDir }
