// Five authorized, public-data tasks through the actual desktop and its existing tool approvals.
// Run only after human approval: node scripts/evaluate-research.mjs --approved-profile default
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedFetch, connectCdp, freeDistinctPorts, projectRoot, spawnManaged, terminateProcessTreeAsync, waitFor } from '../tests/helpers.mjs';

if (process.argv.slice(2).join(' ') !== '--approved-profile default') {
  throw new Error('Explicit human approval for the default profile is required.');
}
const shared = '请用中文直接完成研究和文件交付，不需要询问文风。只研究公开资料；仅使用网页搜索、fetch_markdown、create_docx/create_xlsx 等研究与文档工具，不运行代码、进程或修改已有文件。把新文件保存到默认成果目录。引用必须来自本任务实际读取的网页；Word 用 sources 参数添加可点击参考资料。区分事实与推断，说明失败或部分读取。';
const tasks = [
  ['RESEARCH-01', '搜索 Electron 官方资料，读取至少两个官方页面，研究 Node integration、context isolation、sandbox 三者关系，写一页 Word 给普通开发者。'],
  ['RESEARCH-02', '读取 MDN 的 AbortController 与 Fetch API 官方资料，解释取消下载是否能保证服务端没有副作用。输出一页 Word，清楚区分事实、限制、推断。'],
  ['RESEARCH-03', '研究可编辑 Word 的 Open XML 基本结构与普通文档段落生成，实际读取 Microsoft Learn 与 docx 项目官方资料。生成一份简短 Word 报告和 Excel 来源核对表。'],
  ['RESEARCH-04', '虚构资料：甲公司 2025 年销量 24；乙公司 2024 年销量 21（单位相同，其余口径未说明）。比较两者，实际读取两个官方统计机构关于时间范围或数据可比性的网页；生成 Excel 事实表和一页 Word 谨慎结论。不能把跨公司、跨年份数字当成同一公司的同比增长。未找到适当网页请明确说明。'],
  ['RESEARCH-05', '先尝试读取 https://example.invalid/rainydays-unavailable，再研究 Electron 官方安全指南。说明无法获取的来源，并找到至少两个可读取的 Electron 官方来源，生成简短 Word 报告，不把失败网址列为已读参考。'],
];
const runRoot = path.join(projectRoot, 'test-results', `research-live-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
const userData = path.join(runRoot, 'user-data');
await mkdir(userData, { recursive: true });
const originalRoot = path.join(process.env.APPDATA, 'rainydays');
const original = JSON.parse(await readFile(path.join(originalRoot, 'config.json'), 'utf8'));
const profile = original.profiles?.default;
if (!profile?.credentialRef || profile.apiKey) throw new Error('An encrypted default credential is required; no plaintext credential is copied.');
const vault = JSON.parse(await readFile(path.join(originalRoot, 'credentials.vault.json'), 'utf8'));
if (!vault.entries?.[profile.credentialRef]) throw new Error('The approved encrypted credential is unavailable.');
// Windows Chromium encrypts safeStorage payloads with a DPAPI-protected profile key.
// Carry only that encrypted key, never cookies, history, or other Local State preferences.
const localState = JSON.parse(await readFile(path.join(originalRoot, 'Local State'), 'utf8'));
if (typeof localState.os_crypt?.encrypted_key !== 'string') throw new Error('The protected profile encryption key is unavailable.');
await writeFile(path.join(userData, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: localState.os_crypt.encrypted_key } }));
const roots = Object.fromEntries(['workspaceRoot', 'departmentDataRoot', 'outputDir'].map((name, index) => [name, path.join(userData, ['workspace', 'department', 'output'][index])]));
await Promise.all(Object.values(roots).map(root => mkdir(root, { recursive: true })));
await writeFile(path.join(userData, 'credentials.vault.json'), JSON.stringify({ schemaVersion: 2, entries: { [profile.credentialRef]: vault.entries[profile.credentialRef] }, pendingDeletes: [] }));
await writeFile(path.join(userData, 'config.json'), JSON.stringify({ defaultProfile: 'default', profiles: { default: { model: profile.model, credentialRef: profile.credentialRef, baseURL: profile.baseURL, providerType: profile.providerType } }, settings: { defaultPersona: 'general', ...roots } }));
const [httpPort, cdpPort] = await freeDistinctPorts(2);
let child, client;
const summary = { startedAt: new Date().toISOString(), approvedProfile: 'default', model: profile.model, tasks: [], usage: '未知', cost: '未知' };
const persist = () => writeFile(path.join(runRoot, 'results.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ event: 'starting', runRoot, model: profile.model }));
try {
  child = spawnManaged(path.join(projectRoot, 'node_modules/electron/dist/electron.exe'), [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, '--disable-gpu'], { env: { ...process.env, PORT: String(httpPort), RAINYDAYS_E2E_USE_DIST: '1', RAINYDAYS_E2E_NODE_EXECUTABLE: process.execPath } });
  // Keep bounded startup diagnostics private; never emit credential IPC or provider error bodies.
  let startupLog = '';
  const capture = chunk => { startupLog = (startupLog + chunk.toString()).slice(-24_000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Owned Electron exited ${child.exitCode}`);
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
    }, { timeoutMs: 60_000, label: 'isolated desktop HTTP startup' });
  } catch (error) {
    await writeFile(path.join(runRoot, 'startup-private.log'), startupLog);
    throw error;
  }
  client = await connectCdp(cdpPort);
  await waitFor(async () => { try { return await client.evaluate('Boolean(desktopNavigationReady && currentSessionId && workbenchLayout)'); } catch { return false; } }, { timeoutMs: 45_000, label: 'isolated desktop ready' });
  const ready = await client.evaluate("fetch('/api/status').then(r=>r.json()).then(s=>({configured:s.configured,model:s.model,profile:s.profile}))");
  if (!ready.configured || ready.profile !== 'default') throw new Error('The isolated approved profile is not ready.');
  for (const [id, task] of tasks) {
    const start = Date.now();
    const sessionId = await client.evaluate("(async()=>{if(document.getElementById('settings-modal').classList.contains('visible'))closeSettings(); await newChat();return currentSessionId})()");
    const record = { id, sessionId, prompt: `${shared}\n\n${task}`, startedAt: new Date().toISOString(), status: 'running', approvals: 0, humanInterventions: 0, requestCount: '未知', usage: '未知', cost: '未知' };
    summary.tasks.push(record); await persist();
    console.log(JSON.stringify({ event: 'task-start', id }));
    await client.evaluate(`(()=>{inputEl.value=${JSON.stringify(record.prompt)};inputEl.dispatchEvent(new Event('input'));document.getElementById('input-form').requestSubmit();return true})()`);
    let nextProgress = start + 15_000;
    while (Date.now() - start < 300_000) {
      await delay(750);
      const state = await client.evaluate("({running:isSessionRunning(),question:document.getElementById('ask-modal').classList.contains('visible')?{text:document.getElementById('ask-question-text').textContent,options:[...document.querySelectorAll('#ask-options button')].map(b=>b.textContent)}:null,text:[...document.querySelectorAll('#messages .msg-assistant .bubble')].at(-1)?.textContent||''})");
      if (state.question) {
        // The user has authorized new outputs for these five tasks; no other approval is automated.
        if (state.question.options.includes('本次任务允许新建文档')) {
          record.approvals++;
          await client.evaluate("[...document.querySelectorAll('#ask-options button')].find(b=>b.textContent==='本次任务允许新建文档').click()");
        } else {
          record.status = 'needs-human-input'; record.question = state.question;
          await client.evaluate('cancelSessionRun()'); break;
        }
      }
      if (!state.running) { record.status = state.text.startsWith('执行失败：') ? 'execution-failed' : 'completed'; record.visibleAnswer = state.text; break; }
      if (Date.now() > nextProgress) { console.log(JSON.stringify({ event: 'task-progress', id, elapsedSeconds: Math.round((Date.now() - start) / 1000) })); nextProgress += 15_000; }
    }
    if (record.status === 'running') { record.status = 'timeout'; await client.evaluate('cancelSessionRun()'); }
    await waitFor(() => client.evaluate('!isSessionRunning()'), { timeoutMs: 15_000, label: 'task stopped' }).catch(() => undefined);
    record.endedAt = new Date().toISOString(); record.elapsedSeconds = (Date.now() - start) / 1000;
    const history = await client.evaluate(`fetch('/api/sessions/${encodeURIComponent(sessionId)}/messages').then(r=>r.json())`);
    // All messages here were produced in the isolated fixture from the fixed public prompts.
    await writeFile(path.join(runRoot, `${id}.json`), JSON.stringify(history, null, 2));
    record.sources = history.research?.sources ?? []; record.unreadLinks = history.research?.unreadLinks ?? [];
    record.outputs = history.outputs ?? [];
    record.toolCalls = (history.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.function.name));
    record.quality = 'pending-review';
    await persist();
    console.log(JSON.stringify({ event: 'task-end', id, status: record.status, elapsedSeconds: record.elapsedSeconds, sources: record.sources.length, outputs: record.outputs.length, approvals: record.approvals }));
  }
} finally {
  client?.close();
  if (child) await terminateProcessTreeAsync(child);
  // Remove only our two credential-bearing fixture files after the owned process has exited.
  const relative = path.relative(path.join(projectRoot, 'test-results'), userData);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Credential cleanup target is outside the evaluation directory.');
  await Promise.all(['config.json', 'credentials.vault.json', 'Local State'].map(name => unlink(path.join(userData, name)).catch(error => { if (error.code !== 'ENOENT') throw error; })));
  summary.endedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ event: 'finished', runRoot }));
}
