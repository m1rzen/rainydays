import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'rainydays-task-tools-'));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: fileURLToPath(new URL('../../', import.meta.url)), RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: path.join(fixture, 'data'), RAINYDAYS_PLAYBOOKS_DIR: path.join(fixture, 'playbooks') });
const { closeDb } = await import('../../src/db.ts');
test.after(async () => { closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith('rainydays-task-tools-')); await rm(fixture, { recursive: true, force: true }); });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('按需加载只能接受成功的宿主发现回执，不扩大允许范围；下一任务重置', async () => {
  const { TaskToolSelection } = await import('../../src/task-tools.ts');
  const descriptors = ['read', 'search_tools', 'list_memories'].map(name => ({ name, schema: { type: 'function', function: { name } } }));
  const selected = new TaskToolSelection('general', descriptors);
  assert.deepEqual(selected.protocols().map(d => d.name), ['read', 'search_tools']);
  const outcome = (content, status = 'success', truncated = false) => ({ status, content: JSON.stringify(content), truncated });
  selected.discover('fetch_markdown', outcome({ type: 'tool_discovery', tools: ['list_memories'] }));
  selected.discover('search_tools', outcome({ type: 'tool_discovery', tools: ['list_memories'] }, 'error'));
  selected.discover('search_tools', outcome({ type: 'tool_discovery', tools: ['list_memories'] }, 'success', true));
  assert.equal(selected.has('list_memories'), false);
  selected.discover('search_tools', outcome({ type: 'tool_discovery', tools: ['list_memories', 'execute_command'] }));
  assert.equal(selected.has('list_memories'), true); assert.equal(selected.has('execute_command'), false);
  assert.equal(new TaskToolSelection('general', descriptors).has('list_memories'), false);
  assert.equal(new TaskToolSelection('researcher', descriptors).has('list_memories'), true);
  assert.equal(new TaskToolSelection('general', descriptors.filter(d => d.name !== 'search_tools')).has('list_memories'), true);
});

test('真实 Agent 在发现之前不执行隐藏工具，发现之后加入下一轮并可调用', async () => {
  const [{ Agent }, { ConversationMemory }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }] = await Promise.all([
    import('../../src/agent.ts'), import('../../src/memory.ts'), import('../../src/persona.ts'), import('../../src/session.ts'), import('../../src/tools/index.ts'), import('../../src/path-runtime.ts')]);
  await mkdir(path.join(fixture, 'workspace')); await writeFile(path.join(fixture, 'workspace', 'input.txt'), 'public fixture');
  const persona = createEffectivePersona({ name: 'general', displayName: 'Test', description: '', permissionLevel: 'read_only', tools: ['read', 'search_tools', 'list_memories'], env: { OUTPUT_DIR: path.join(fixture, 'workspace') }, allowedRoots: [], networkPolicy: { mode: 'deny' }, systemPrompt: 'Fixture' });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { OUTPUT_DIR: 'output' }, pathAuthority: await pathPolicy.createAuthority([{ rootId: 'output', role: 'output', configuredPath: path.join(fixture, 'workspace'), permissions: ['read-file', 'read-directory'] }]) });
  const session = createSession(persona, 'Selection');
  const sizes = [];
  let iteration = 0;
  const llm = { async chat() { return { role: 'assistant', content: 'Fixture' }; }, async *chatStream(messages, tools) {
    sizes.push(tools.map(t => t.function.name));
    const step = iteration++;
    if (step === 0) yield { type: 'result', message: { role: 'assistant', content: '', tool_calls: [call('guess', 'list_memories', {})] } };
    else if (step === 1) {
      assert.match(messages.at(-1).content, /search_tools/u);
      yield { type: 'result', message: { role: 'assistant', content: '', tool_calls: [call('discover', 'search_tools', { keywords: 'list_memories execute_command' })] } };
    } else if (step === 2) {
      assert(tools.some(tool => tool.function.name === 'list_memories')); assert(!tools.some(tool => tool.function.name === 'execute_command'));
      yield { type: 'result', message: { role: 'assistant', content: '', tool_calls: [call('use', 'list_memories', {})] } };
    } else {
      if (step === 4) assert(!tools.some(tool => tool.function.name === 'list_memories'), '下一任务不能保留上次加载状态');
      yield { type: 'result', message: { role: 'assistant', content: 'Complete' } };
    }
  } };
  const agent = new Agent(llm, new ConversationMemory(), persona, authority); agent.setSession(session.id);
  const events = []; for await (const event of agent.run('检查记忆', 'selection-run')) events.push(event);
  assert.equal(events.find(e => e.type === 'tool_result' && e.toolName === 'list_memories').toolStatus, 'denied');
  assert.equal(events.filter(e => e.type === 'tool_result' && e.toolName === 'list_memories').at(-1).toolStatus, 'success');
  assert.deepEqual(sizes[0], ['read', 'search_tools']);
  for await (const _event of agent.run('新的简单任务', 'selection-run-2')) { /* consume actual next run */ }
  assert.deepEqual(sizes.at(-1), ['read', 'search_tools']);
});
