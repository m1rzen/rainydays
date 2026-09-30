import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { LLMClient } from '../../src/llm.ts';

test('连接检测只发一次短消息，不带历史、工具或自动重试', async () => {
  const bodies = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new LLMClient({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' });
    await client.probe(AbortSignal.timeout(2000));
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0], { model: 'fixture', messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 16 });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('检测的错误有下一步，提供方错误与秘密不回显，失败不重试', async () => {
  const { probeProviderConnection } = await import('../../src/model-connection.ts');
  const cases = [[401, 'apiKey', '密钥'], [403, 'monthly usage limit', '额度'], [403, 'denied', '权限'], [404, 'model missing', '模型'], [429, 'busy', '稍后'], [503, 'offline', '服务']];
  for (const [status, message, expected] of cases) {
    let calls = 0;
    const result = await probeProviderConnection({ probe: async () => { calls++; throw Object.assign(new Error(`${message} SECRET_FIXTURE`), { status }); } });
    assert.equal(result.ok, false); assert.equal(calls, 1);
    assert.match(result.message, new RegExp(expected));
    assert.doesNotMatch(JSON.stringify(result), /SECRET_FIXTURE/);
  }
  assert.equal((await probeProviderConnection({ probe: async () => {} })).ok, true);
  const timeout = await probeProviderConnection({ probe: async () => { throw Object.assign(new Error('private'), { name: 'AbortError' }); } });
  assert.match(timeout.message, /超时/);
});
