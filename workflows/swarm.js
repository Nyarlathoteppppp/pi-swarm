export const meta = {
  name: 'swarm',
  description: 'Prepare a DSF sample, obtain user approval, then qualify three shards and execute waves of six',
  whenToUse: 'Large partitioned inspect/edit tasks, including classification and review under user-confirmed criteria; preparation may start with one sample',
  phases: [
    { title: 'Preflight', detail: 'separate read scopes, write targets, and task contracts' },
    { title: 'Pilot 1', detail: 'one OpenRouter DeepSeek Flash sample, followed by user discussion' },
    { title: 'Qualify 3', detail: 'one OpenRouter and two official DeepSeek shards' },
    { title: 'Swarm 6', detail: 'waves of at most four OpenRouter and two official DeepSeek shards' },
  ],
}

// Invoke via SubagentWorkflow.scriptPath at this source file; named discovery rejects symlinks.
// First call: mode, cwd, objective, optional draft rule, sharedReadPaths, shards (one is enough).
// Shard: id, instruction, expected; optional paths and stopConditions.
// Edit shards additionally require exact allowedFiles, preconditions, and forbiddenActions.
// First shard is the representative pilot. Partition records or review concerns in instruction.
// Shared inputs may overlap, but must stay stable during concurrent work.
// Reuse a successful pilotRecord to assemble the full batch without rerunning an edit sample.
// The returned pilotApproval covers the full contract. After the user reviews that contract and
// sample, resubmit both records, changing only pilotApproval.approvedByUser to true.
// Records are caller-supplied workflow state, not authenticated proof of human approval.
// Resume later execution with Tintin resumeFromRunId only when inputs and the approved contract
// are still valid. A replay reuses a prefix, not arbitrary completed shards or file snapshots.

const OPENROUTER_DSF = 'litellm-local/or-deepseek-v4-flash-latest'
const OFFICIAL_DSF = 'litellm-local/deepseek-bot-v4-flash'
const EFFORT = 'low'

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    shardId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'needs_user_input', 'blocked'] },
    summary: { type: 'string' },
    filesInspected: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
    validation: { type: 'array', items: { type: 'string' } },
    questionsForUser: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'shardId', 'status', 'summary', 'filesInspected', 'filesChanged',
    'evidence', 'validation', 'questionsForUser', 'notes', 'outOfScope',
  ],
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = value => typeof value === 'string' && value.trim().length > 0
const isTextArray = value => Array.isArray(value) && value.every(isText)
const isAbsolutePath = value => isText(value) && value.startsWith('/') && !value.split('/').includes('..')
const cleanPath = value => '/' + value.split('/').filter(part => part && part !== '.').join('/')
const withinScope = (file, scopes) => scopes.some(scope =>
  scope === '/' || file === scope || file.startsWith(scope + '/'))
const pathsOverlap = (left, right) => withinScope(left, [right]) || withinScope(right, [left])
// Compare the readable approval snapshot structurally; object key order is not a task change.
const sameValue = (left, right) => {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  }
  if (!isObject(left) || !isObject(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]))
}
const fail = message => { throw new Error('swarm preflight: ' + message) }
const textList = (value, field, required = false) => {
  const list = value === undefined ? [] : value
  if (!isTextArray(list) || (required && list.length === 0)) fail(field + ' must be a' + (required ? ' non-empty' : '') + ' string array')
  return list
}
const pathList = (value, field, required = false) => {
  const list = textList(value, field, required)
  if (!list.every(isAbsolutePath)) fail(field + ' requires absolute paths without ".." segments')
  return [...new Set(list.map(cleanPath))]
}

phase('Preflight')
if (!isObject(args)) fail('args must be an object')
for (const key of ['model', 'effort', 'thinking', 'agentType', 'concurrency', 'maxConcurrent', 'skipPilot', 'pilotApproved', 'startAt']) {
  if (Object.prototype.hasOwnProperty.call(args, key)) fail('args.' + key + ' cannot override the fixed workflow policy')
}
const mode = args.mode
if (mode !== 'inspect' && mode !== 'edit') fail('mode must be inspect or edit')
if (!isAbsolutePath(args.cwd)) fail('cwd must be an absolute path without .. segments')
if (!isText(args.objective)) fail('objective is required')
if (args.rule !== undefined && typeof args.rule !== 'string') fail('rule must be a string')
const cwd = cleanPath(args.cwd)
const rule = args.rule ?? ''
const sharedReadPaths = pathList(args.sharedReadPaths, 'sharedReadPaths')
if (!Array.isArray(args.shards) || args.shards.length === 0) fail('at least one pilot shard is required')
const ids = new Set()
const claimedWrites = []
const shards = args.shards.map((raw, index) => {
  if (!isObject(raw)) fail('shards[' + index + '] must be an object')
  if (!isText(raw.id) || !/^[A-Za-z0-9._-]+$/.test(raw.id)) fail('shards[' + index + '].id must use letters, numbers, dot, underscore, or hyphen')
  if (ids.has(raw.id)) fail('duplicate shard id: ' + raw.id)
  ids.add(raw.id)
  if (!isText(raw.instruction)) fail(raw.id + ': instruction is required')
  const paths = pathList(raw.paths, raw.id + '.paths')
  const allowedFiles = pathList(raw.allowedFiles, raw.id + '.allowedFiles', mode === 'edit')
  if (mode === 'inspect' && allowedFiles.length) fail(raw.id + ': inspect mode cannot declare writes')
  for (const file of allowedFiles) {
    if (!withinScope(file, [cwd]) || file === cwd) fail(raw.id + ': write target must be a file under cwd: ' + file)
    const overlap = claimedWrites.find(entry => pathsOverlap(file, entry.file))
    if (overlap) fail(raw.id + ': write target ' + file + ' overlaps ' + overlap.id + ': ' + overlap.file)
    claimedWrites.push({ id: raw.id, file })
  }
  if (sharedReadPaths.length + paths.length + allowedFiles.length === 0) fail(raw.id + ': declare a readable input')
  return {
    id: raw.id,
    instruction: raw.instruction,
    paths,
    allowedFiles,
    expected: textList(raw.expected, raw.id + '.expected', true),
    stopConditions: textList(raw.stopConditions, raw.id + '.stopConditions'),
    preconditions: textList(raw.preconditions, raw.id + '.preconditions', mode === 'edit'),
    forbiddenActions: textList(raw.forbiddenActions, raw.id + '.forbiddenActions', mode === 'edit'),
  }
})
const readScopes = shard => [...new Set([...sharedReadPaths, ...shard.paths, ...shard.allowedFiles])]
const contract = { mode, cwd, objective: args.objective, rule, sharedReadPaths, shards }
const pilotContract = { mode, cwd, objective: args.objective, rule, sharedReadPaths, shard: shards[0] }
const approval = args.pilotApproval
// Approval validates the entire rollout, before any new child can be started.
if (approval !== undefined) {
  if (!isObject(approval) || approval.approvedByUser !== true) fail('pilotApproval requires explicit user approval')
  if (!sameValue(approval.contract, contract)) fail('approved execution contract changed; present the current contract for user approval')
  if (shards.length < 4) fail('rollout requires the pilot plus at least three qualification shards')
  if (!isText(rule)) fail('confirm a shared rule before rollout')
  if (args.pilotRecord === undefined) fail('rollout requires the successful pilotRecord')
}

const promptFor = shard => [
  'You are a DeepSeek Flash swarm ' + (mode === 'edit' ? 'Operator' : 'Explore') + ' shard.',
  'Project directory: ' + cwd + ' (the workflow inherits the main Pi working directory).',
  'Shard ID: ' + shard.id,
  'Mode: ' + mode,
  '', 'Overall objective:', args.objective,
  '', 'Shared rule (may be a draft during pilot preparation):', rule || '(Not yet specified; identify the criteria needed for a representative sample.)',
  '', 'This shard:', shard.instruction,
  '', 'Allowed read paths, including shared references:', ...readScopes(shard).map(path => '- ' + path),
  ...(mode === 'edit' ? [
    '', 'Allowed files (exact complete write allowlist):', ...shard.allowedFiles.map(path => '- ' + path),
    '', 'Preconditions before editing:', ...shard.preconditions.map(item => '- ' + item),
    '', 'Forbidden actions:', ...shard.forbiddenActions.map(item => '- ' + item),
  ] : []),
  '', 'Expected result:', ...shard.expected.map(item => '- ' + item),
  '', 'Additional stopping conditions:', ...shard.stopConditions.map(item => '- ' + item),
  '', 'Execution rules:',
  '- Read shared sources as needed, but process only the records or review concerns assigned to this shard. Cite absolute paths and evidence.',
  '- Apply confirmed semantic criteria for classification, scoring, review, or bounded edits. Do not invent business rules or expand the task.',
  '- During preparation, inspect inputs and propose concrete rule clarifications or sample improvements in summary. For a missing standard, threshold, or source-of-truth decision, return status needs_user_input with concise questionsForUser and relevant evidence.',
  '- Ask before changes that depend on an unresolved decision. If a new question appears after valid earlier edits, stop further edits and truthfully report all partial filesChanged; never hide them or automatically roll them back.',
  '- Ordinary missing evidence, negative findings, and cases already covered by the rule belong in notes; they do not block completion.',
  '- Use blocked for execution failures or unmet prerequisites; report boundary violations in outOfScope. Do not keep exploring indefinitely.',
  mode === 'edit'
    ? '- Write only allowedFiles; shared read access grants no additional writes. A verified already-compliant result may have empty filesChanged: explain it with evidence and validation.'
    : '- This is read-only: filesChanged must be empty.',
  '- Record checks actually performed in validation, distinguish unrun checks in notes, and return the required structured object.',
].join('\n')

const validateResult = (result, shard, qualification) => {
  if (!isObject(result)) return 'agent returned no structured result or failed'
  if (result.shardId !== shard.id) return 'returned wrong shardId: ' + result.shardId
  for (const field of ['filesInspected', 'filesChanged', 'evidence', 'validation', 'questionsForUser', 'notes', 'outOfScope']) {
    if (!isTextArray(result[field])) return field + ' must be a string array'
  }
  if (result.filesInspected.some(file => !isAbsolutePath(file) || !withinScope(cleanPath(file), readScopes(shard)))) return 'reported an inspected file outside read scope'
  if (result.filesChanged.some(file => !isAbsolutePath(file) || !shard.allowedFiles.includes(cleanPath(file)))) return 'reported a changed file outside write scope'
  if (result.outOfScope.length) return 'reported out-of-scope activity: ' + result.outOfScope.join('; ')
  if (result.questionsForUser.length) return 'requires user judgment: ' + result.questionsForUser.join('; ')
  if (result.status !== 'completed') return 'status is ' + result.status
  if (!isText(result.summary)) return 'reported no summary'
  if (!result.validation.length) return 'reported no validation'
  if ((qualification || (mode === 'edit' && !result.filesChanged.length)) && !result.evidence.length) return 'reported no evidence for qualification or no-change result'
  return null
}
const runShard = (shard, model, stage) => agent(promptFor(shard), {
  label: stage + ':' + shard.id, phase: stage,
  agentType: mode === 'edit' ? 'Operator' : 'Explore', model, effort: EFFORT, schema: RESULT_SCHEMA,
})
const completed = []
const reportedChanges = entries => [...new Set(entries.flatMap(entry =>
  isObject(entry.result) && isTextArray(entry.result.filesChanged) ? entry.result.filesChanged : []))]
const progressResult = (failed = []) => ({
  mode,
  completed,
  failed,
  remainingShardIds: shards.filter(shard => !completed.some(entry => entry.shardId === shard.id)).map(shard => shard.id),
  reportedChangedFiles: reportedChanges([...completed, ...failed]),
  requiresMainValidation: mode === 'edit',
})
const stopResult = (stage, failed) => {
  const questionsForUser = [...new Set(failed.flatMap(entry =>
    isObject(entry.result) && isTextArray(entry.result.questionsForUser) ? entry.result.questionsForUser : []))]
  return {
    workflowStatus: questionsForUser.length ? 'needs_user_input' : 'blocked',
    failedStage: stage,
    reason: failed.map(entry => entry.shardId + ': ' + entry.reason).join('; '),
    ...progressResult(failed),
    requiresUserInput: questionsForUser.length > 0,
    questionsForUser,
  }
}

phase('Pilot 1')
let pilot
if (args.pilotRecord !== undefined) {
  if (!isObject(args.pilotRecord) || !sameValue(args.pilotRecord.contract, pilotContract)) fail('pilot inputs or sample contract changed; rerun the affected sample without pilotRecord')
  pilot = args.pilotRecord.result
  const issue = validateResult(pilot, shards[0], true)
  if (issue) fail('pilotRecord is not a successful sample: ' + issue)
} else {
  pilot = await runShard(shards[0], OPENROUTER_DSF, 'Pilot 1')
  const issue = validateResult(pilot, shards[0], true)
  if (issue) return stopResult('pilot', [{ shardId: shards[0].id, lane: 'openrouter', reason: issue, result: pilot }])
}
const pilotRecord = { contract: pilotContract, result: pilot }
completed.push({ shardId: shards[0].id, lane: 'openrouter', result: pilot })
if (approval === undefined) {
  const ready = shards.length >= 4 && isText(rule)
  log(ready ? 'sample passed; waiting for user approval of sample and full batch' : 'sample passed; prepare the full batch and shared rule for user review')
  return {
    workflowStatus: ready ? 'awaiting_pilot_approval' : 'preparing',
    ...progressResult(),
    pilotRecord,
    pilotApproval: ready ? { approvedByUser: false, contract } : null,
    requiresUserInput: true,
    questionsForUser: [ready
      ? '请确认 Pilot 的证据、修改和验证结果，以及本次完整批次的规则与执行范围；是否批准进入三代理验证及后续六代理批次？'
      : '请查看 Pilot 样例并讨论判定标准；主 Pi 将补齐完整分片和规则，再提交批量执行范围供你确认。'],
  }
}

// Keep call order stable so native Tintin prefix replay can reuse unchanged execution calls.
const runBatch = async (batch, models, lanes, stage, qualify) => {
  const results = await parallel(batch.map((shard, index) => () => runShard(shard, models[index], stage)))
  const failed = []
  results.forEach((result, index) => {
    const shard = batch[index]
    const entry = { shardId: shard.id, lane: lanes[index], result }
    const issue = validateResult(result, shard, qualify)
    if (issue) failed.push({ ...entry, reason: issue })
    else completed.push(entry)
  })
  return failed
}
phase('Qualify 3')
const qualificationFailures = await runBatch(shards.slice(1, 4),
  [OPENROUTER_DSF, OFFICIAL_DSF, OFFICIAL_DSF],
  ['openrouter', 'official-deepseek', 'official-deepseek'], 'Qualify 3', true)
if (qualificationFailures.length) return { ...stopResult('qualification', qualificationFailures), pilotRecord }

phase('Swarm 6')
const fullModels = [OPENROUTER_DSF, OFFICIAL_DSF, OPENROUTER_DSF, OFFICIAL_DSF, OPENROUTER_DSF, OPENROUTER_DSF]
const fullLanes = ['openrouter', 'official-deepseek', 'openrouter', 'official-deepseek', 'openrouter', 'openrouter']
for (let offset = 4; offset < shards.length; offset += 6) {
  log('starting wave ' + (Math.floor((offset - 4) / 6) + 1))
  const failures = await runBatch(shards.slice(offset, offset + 6), fullModels, fullLanes, 'Swarm 6', false)
  if (failures.length) return { ...stopResult('swarm', failures), pilotRecord }
}
return {
  workflowStatus: 'completed',
  ...progressResult(),
  stages: { pilot: 1, qualification: 3, swarm: shards.length - 4 },
  requestedModels: { openrouter: OPENROUTER_DSF, officialDeepSeek: OFFICIAL_DSF, effort: EFFORT },
  expectedFiles: shards.flatMap(shard => shard.allowedFiles),
  requiresUserInput: false,
  questionsForUser: [],
}
