import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const tintinDir = process.env.PI_SUBAGENTS_DIR || join(homedir(), '.pi/agent/npm/node_modules/@tintinweb/pi-subagents')
const { runWorkflow, validateScript } = await import(pathToFileURL(join(tintinDir, 'dist/workflow/runtime.js')))

// Uses the installed Tintin worker/runtime and JSON Schema validation, with a local fake model
// host. No credentials, provider requests, or target project files are read or changed.
const sourcePath = new URL('../workflows/swarm.js', import.meta.url).pathname
const script = readFileSync(sourcePath, 'utf8')
const OR = 'litellm-local/or-deepseek-v4-flash-latest'
const DS = 'litellm-local/deepseek-bot-v4-flash'
const makeArgs = (count = 4, mode = 'inspect') => ({
  mode,
  cwd: '/fixture/project',
  objective: 'Classify independent job groups using evidence',
  rule: 'Score only demonstrated skills; absent evidence means unknown.',
  sharedReadPaths: ['/fixture/references/profile.md', '/fixture/references/rubric.md'],
  shards: Array.from({ length: count }, (_, index) => ({
    id: 's' + index,
    instruction: 'Process only group ' + index + ' of jobs.csv',
    paths: ['/fixture/project/jobs.csv'],
    expected: ['Cite the relevant record and rubric criterion'],
    ...(mode === 'edit' ? {
      allowedFiles: ['/fixture/project/output-' + index + '.json'],
      preconditions: ['Input record exists'],
      forbiddenActions: ['Do not modify the shared inputs'],
    } : {}),
  })),
})
const resultFor = (request, args) => {
  const id = request.prompt.match(/Shard ID: (.+)/)[1]
  const shard = args.shards.find(item => item.id === id)
  return {
    shardId: id,
    status: 'completed',
    summary: args.mode === 'edit' ? 'Output was already compliant; inspected its contents.' : 'Group classified.',
    filesInspected: [...(args.sharedReadPaths || []), ...(shard.paths || []), ...(shard.allowedFiles || [])],
    filesChanged: [],
    evidence: ['jobs.csv record ' + id + ': skill requirement; rubric section 2: missing evidence is unknown'],
    validation: ['Compared every assigned record with the rubric'],
    questionsForUser: [],
    notes: [],
    outOfScope: [],
  }
}
const execute = async (args, { transform, entries = [] } = {}) => {
  const fixtureArgs = { ...args.pilotApproval?.contract, ...args }
  const calls = []
  const journal = []
  let active = 0
  let maxActive = 0
  const run = await runWorkflow({
    script, args, concurrency: 6,
    journal: { entries, append: entry => journal.push(entry) },
    host: {
      async spawnAgent(request) {
        calls.push(request)
        active++
        maxActive = Math.max(maxActive, active)
        try {
          await new Promise(resolve => setTimeout(resolve, 2))
          const result = transform ? transform(resultFor(request, fixtureArgs), request) : resultFor(request, fixtureArgs)
          return result === null ? { ok: false, error: 'fixture transport failure' } : { ok: true, text: JSON.stringify(result) }
        } finally { active-- }
      },
      abortAgent() {},
    },
  })
  return { ...run, calls, journal, maxActive }
}
const successfulValue = run => {
  assert.equal(run.status, 'completed', run.error)
  return run.value
}
const approvedArgs = (args, pilot) => ({
  ...args,
  pilotRecord: pilot.pilotRecord,
  pilotApproval: { ...pilot.pilotApproval, approvedByUser: true },
})

test('real Tintin parses the canonical source path and metadata', () => {
  assert.equal(validateScript(script).meta.name, 'swarm')
})

test('shared reads and notes pass; first call stops after one pilot', async () => {
  const run = await execute(makeArgs(), { transform: result => ({ ...result, notes: ['No evidence of skill X; treated as unknown.'] }) })
  const out = successfulValue(run)
  assert.equal(out.workflowStatus, 'awaiting_pilot_approval')
  assert.equal(run.calls.length, 1)
  assert.equal(out.completed[0].result.notes.length, 1)
  assert.equal(out.pilotApproval.approvedByUser, false)
  assert.equal(run.calls[0].agentType, 'Explore')
})

test('single pilot can prepare, then attach a full batch without repeating the sample', async () => {
  const args = makeArgs(1, 'edit')
  const first = await execute(args)
  const pilot = successfulValue(first)
  assert.equal(pilot.workflowStatus, 'preparing')
  assert.equal(pilot.pilotApproval, null)
  const fullArgs = { ...makeArgs(10, 'edit'), pilotRecord: pilot.pilotRecord }
  const prepared = await execute(fullArgs)
  const out = successfulValue(prepared)
  assert.equal(out.workflowStatus, 'awaiting_pilot_approval')
  assert.equal(prepared.calls.length, 0)
  const execution = await execute(approvedArgs(fullArgs, out))
  assert.equal(successfulValue(execution).completed.length, 10)
  assert.equal(execution.calls.length, 9)
  assert.ok(execution.calls.every(call => call.agentType === 'Operator'))
})

test('two original records resume the full edit batch without repeating the pilot', async () => {
  const pilot = successfulValue(await execute(makeArgs(10, 'edit')))
  const input = {
    pilotRecord: pilot.pilotRecord,
    pilotApproval: { ...pilot.pilotApproval, approvedByUser: true },
  }
  const run = await execute(input)
  assert.equal(successfulValue(run).completed.length, 10)
  assert.equal(run.calls.length, 9)
  assert.ok(run.calls.every(call => !call.prompt.includes('Shard ID: s0\n')))
  const changed = await execute({ ...input, rule: 'Changed without approval' })
  assert.equal(changed.status, 'failed')
  assert.match(changed.error, /contract changed at rule/)
  assert.equal(changed.calls.length, 0)
})

test('prohibitions in notes pass but reported actual out-of-scope activity blocks', async () => {
  const args = makeArgs()
  const good = await execute(args, { transform: result => ({ ...result, notes: ['Did not modify shared inputs.'] }) })
  assert.equal(successfulValue(good).workflowStatus, 'awaiting_pilot_approval')
  assert.match(good.calls[0].prompt, /unauthorized actions actually performed/)
  const bad = await execute(args, { transform: result => ({ ...result, outOfScope: ['Modified an unauthorized input.'] }) })
  assert.equal(successfulValue(bad).workflowStatus, 'blocked')
})

test('draft criteria permit evidence collection and return concrete questions', async () => {
  const args = makeArgs(1)
  delete args.rule
  const out = successfulValue(await execute(args, { transform: result => ({
    ...result, status: 'needs_user_input', questionsForUser: ['Which source is authoritative?'],
  }) }))
  assert.equal(out.workflowStatus, 'needs_user_input')
  assert.deepEqual(out.questionsForUser, ['Which source is authoritative?'])
  assert.equal(out.failed[0].result.evidence.length, 1)
  assert.equal(out.failed[0].result.summary, 'Group classified.')
})

test('partial edit and evidence survive a late clarification request', async () => {
  const args = makeArgs(1, 'edit')
  const out = successfulValue(await execute(args, { transform: result => ({
    ...result, status: 'needs_user_input', filesChanged: args.shards[0].allowedFiles,
    questionsForUser: ['How should the remaining ambiguous record be classified?'],
  }) }))
  assert.equal(out.workflowStatus, 'needs_user_input')
  assert.deepEqual(out.reportedChangedFiles, args.shards[0].allowedFiles)
  assert.equal(out.failed[0].result.validation.length, 1)
  assert.equal(out.requiresMainValidation, true)
})

test('no-change edit passes with evidence, but not without evidence', async () => {
  const args = makeArgs(1, 'edit')
  assert.equal(successfulValue(await execute(args)).workflowStatus, 'preparing')
  const out = successfulValue(await execute(args, { transform: result => ({ ...result, evidence: [] }) }))
  assert.equal(out.workflowStatus, 'blocked')
  assert.match(out.reason, /no evidence/)
})

test('overlapping writes and writes to external references fail before spawning', async () => {
  const args = makeArgs(4, 'edit')
  args.shards[1].allowedFiles = ['/fixture/project/./output-0.json']
  let run = await execute(args)
  assert.equal(run.status, 'failed')
  assert.match(run.error, /overlaps/)
  assert.equal(run.calls.length, 0)
  args.shards[1].allowedFiles = ['/fixture/references/rubric.md']
  run = await execute(args)
  assert.equal(run.status, 'failed')
  assert.equal(run.calls.length, 0)
})

test('shared-read permission never authorizes writing it; failed writes remain visible', async () => {
  const args = makeArgs(1, 'edit')
  const out = successfulValue(await execute(args, { transform: result => ({
    ...result, filesChanged: ['/fixture/references/rubric.md'],
  }) }))
  assert.equal(out.workflowStatus, 'blocked')
  assert.match(out.reason, /outside write scope/)
  assert.deepEqual(out.reportedChangedFiles, ['/fixture/references/rubric.md'])
})

test('explicit approval and successful pilot are both required', async () => {
  const args = makeArgs()
  const pilot = successfulValue(await execute(args))
  for (const input of [
    { ...args, pilotRecord: pilot.pilotRecord, pilotApproval: pilot.pilotApproval },
    { ...args, pilotApproval: { ...pilot.pilotApproval, approvedByUser: true } },
    { ...args, pilotApproval: true },
  ]) {
    const run = await execute(input)
    assert.equal(run.status, 'failed')
    assert.equal(run.calls.length, 0)
  }
})

test('approval is invalidated by mode, shared inputs, scope, or later shard contract changes', async () => {
  const args = makeArgs(4, 'edit')
  const pilot = successfulValue(await execute(args))
  for (const mutate of [
    input => { input.mode = 'inspect'; input.shards.forEach(shard => { delete shard.allowedFiles }) },
    input => { input.sharedReadPaths.push('/fixture/references/another.md') },
    input => { input.cwd = '/fixture' },
    input => { input.shards[1].allowedFiles = ['/fixture/project/replacement.json'] },
    input => { input.shards[1].instruction += ' with new scoring' },
    input => { input.shards[1].preconditions.push('new prerequisite') },
    input => { input.shards[1].expected.push('new deliverable') },
    input => { input.rule += ' New threshold.' },
  ]) {
    const input = structuredClone(approvedArgs(args, pilot))
    mutate(input)
    const run = await execute(input)
    assert.equal(run.status, 'failed')
    assert.equal(run.calls.length, 0)
    assert.match(run.error, /contract changed/)
  }
  const changedPilot = structuredClone(approvedArgs(args, pilot))
  changedPilot.pilotRecord.contract.shard.instruction += ' changed'
  const run = await execute(changedPilot)
  assert.equal(run.status, 'failed')
  assert.equal(run.calls.length, 0)
})

test('30 items execute as 1, user approval, 3, 6, 6, 6, 6, 2 with fixed provider lanes', async () => {
  const args = makeArgs(30)
  const pilotRun = await execute(args)
  const pilot = successfulValue(pilotRun)
  const run = await execute(approvedArgs(args, pilot))
  const out = successfulValue(run)
  assert.equal(out.workflowStatus, 'completed')
  assert.equal(out.completed.length, 30)
  assert.equal(new Set(out.completed.map(item => item.shardId)).size, 30)
  assert.equal(run.maxActive, 6)
  assert.equal(pilotRun.calls[0].model, OR)
  assert.deepEqual(run.calls.slice(0, 3).map(call => call.model), [OR, DS, DS])
  for (let index = 3; index < run.calls.length; index += 6) {
    const wave = run.calls.slice(index, index + 6)
    assert.deepEqual(wave.map(call => call.model), [OR, DS, OR, DS, OR, OR].slice(0, wave.length))
  }
  assert.ok(run.calls.every(call => call.effort === 'low'))
})

test('qualification failures preserve all results and prevent six-agent waves', async () => {
  const args = makeArgs(10, 'edit')
  const pilot = successfulValue(await execute(args))
  const run = await execute(approvedArgs(args, pilot), { transform: result => result.shardId === 's2'
    ? { ...result, status: 'blocked', summary: 'Prerequisite failed after a partial edit', filesChanged: ['/fixture/project/output-2.json'] }
    : result })
  const out = successfulValue(run)
  assert.equal(out.failedStage, 'qualification')
  assert.equal(run.calls.length, 3)
  assert.equal(out.completed.length, 3)
  assert.equal(out.failed[0].result.summary, 'Prerequisite failed after a partial edit')
  assert.deepEqual(out.reportedChangedFiles, ['/fixture/project/output-2.json'])
})

test('wave failure waits for current siblings, preserves successes, and starts no next wave', async () => {
  const args = makeArgs(16)
  const pilot = successfulValue(await execute(args))
  const run = await execute(approvedArgs(args, pilot), { transform: result => result.shardId === 's5'
    ? { ...result, status: 'needs_user_input', questionsForUser: ['New global scoring case: which rule?'] }
    : result })
  const out = successfulValue(run)
  assert.equal(out.failedStage, 'swarm')
  assert.equal(run.calls.length, 9)
  assert.equal(out.completed.length, 9)
  assert.deepEqual(out.remainingShardIds, ['s5', 's10', 's11', 's12', 's13', 's14', 's15'])
})

test('native execution replay reuses prefix after transport failure; blocked data is cached', async () => {
  const args = makeArgs(10)
  const pilot = successfulValue(await execute(args))
  const input = approvedArgs(args, pilot)
  const failed = await execute(input, { transform: result => result.shardId === 's4' ? null : result })
  assert.equal(successfulValue(failed).failedStage, 'swarm')
  const resumed = await execute(input, { entries: failed.journal })
  assert.equal(successfulValue(resumed).workflowStatus, 'completed')
  assert.equal(resumed.replayedCount, 3)
  assert.equal(resumed.calls.length, 6)
  const blocked = await execute(input, { transform: result => result.shardId === 's1'
    ? { ...result, status: 'blocked', summary: 'Input missing' } : result })
  const cached = await execute(input, { entries: blocked.journal })
  assert.equal(successfulValue(cached).workflowStatus, 'blocked')
  assert.equal(cached.calls.length, 0)
})
