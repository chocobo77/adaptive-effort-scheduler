/** Timeline dump for auditing: lifecycle, selection, and header events only. */
import fs from 'node:fs'
import zlib from 'node:zlib'

for (const file of process.argv.slice(2)) {
  const events = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
  console.log(`\n=== ${(file.split(/[\\/]/).slice(-2, -1)[0] ?? '').slice(0, 26)} ===`)
  for (const event of events) {
    if (!['turn/start', 'turn/end', 'agent/created', 'agent/disposed', 'agent/inbox/claimed', 'agent/inbox/spliced',
      'model/selection', 'request/header', 'session/model', 'compaction/start', 'user/message'].includes(event.type)) continue
    let extra = ''
    if (event.type === 'model/selection') extra = ` ${event.data?.provider}/${event.data?.model} effort=${event.data?.reasoningEffort ?? '-'}`
    if (event.type === 'request/header') extra = ` effort=${event.data?.header?.config?.reasoningEffort ?? '-'} reason=${event.data?.reason}`
    if (event.type === 'turn/start') extra = ` turn=${event.data?.turn}`
    if (event.type === 'user/message') extra = ` chars=${(event.data?.message?.content ?? []).reduce?.((sum, block) => sum + (block?.text?.length ?? 0), 0) ?? String(event.data?.message?.content ?? '').length}`
    if (event.type === 'session/model') extra = ' NOTICE'
    if (event.type === 'agent/inbox/claimed') extra = ' (claimed)'
    console.log(`${String(event.seq).padStart(5)}  ${event.type.padEnd(20)}${extra}`)
  }
}
