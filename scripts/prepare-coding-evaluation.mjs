// Creates local, disposable assessment projects. Never calls a model or loads
// application credentials. Reference implementations stay outside project roots.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const sample = (input, output) => ({ input, output });
const cases = [
  ["J01", "两数求和", "返回两个数的和，支持负数和零。", [sample([2, 3], 5), sample([-2, 2], 0), sample([0, 4], 4)], "return value[0] + value[1];"],
  ["J02", "标题转短链接", "去除首尾空白、转小写，将连续空白转成一个连字符。", [sample("  Rainy Days  ", "rainy-days"), sample("A   B", "a-b"), sample("", "")], "return value.trim().toLowerCase().replace(/\\s+/g, '-');"],
  ["J03", "数值限幅", "把n限制在min与max之间，边界包含在内。", [sample({ n: -1, min: 0, max: 10 }, 0), sample({ n: 7, min: 0, max: 10 }, 7), sample({ n: 11, min: 0, max: 10 }, 10)], "return Math.min(value.max, Math.max(value.min, value.n));"],
  ["J04", "保序去重", "删除重复元素，保留首次出现的顺序，不修改输入数组。", [sample(["b", "a", "b"], ["b", "a"]), sample([], []), sample([0, 0, 1], [0, 1])], "return [...new Set(value)];"],
  ["J05", "类别计数", "统计每个字符串的出现次数，空输入返回空对象。", [sample(["a", "b", "a"], { a: 2, b: 1 }), sample([], {}), sample(["x"], { x: 1 })], "return Object.fromEntries([...new Set(value)].map(key => [key, value.filter(item => item === key).length]));"],
  ["J06", "列表分块", "按正整数size分块，末块可不足size；空列表返回空列表。", [sample({ items: [1, 2, 3, 4, 5], size: 2 }, [[1, 2], [3, 4], [5]]), sample({ items: [], size: 3 }, [])], "return Array.from({length: Math.ceil(value.items.length / value.size)}, (_, i) => value.items.slice(i * value.size, (i + 1) * value.size));"],
  ["J07", "空值回退", "只有actual为null或缺省时使用fallback；保留0、false和空字符串。", [sample({ actual: 0, fallback: 9 }, 0), sample({ actual: null, fallback: 9 }, 9), sample({ actual: false, fallback: true }, false)], "return value.actual ?? value.fallback;"],
  ["J08", "UTF-8字节数", "返回文本的UTF-8字节数，正确处理中文和emoji。", [sample("hello", 5), sample("中文", 6), sample("🌧", 4), sample("", 0)], "return Buffer.byteLength(value, 'utf8');"],
  ["J09", "稳定排序", "按score降序返回新数组；同分项保留原顺序，不修改输入。", [sample([{ id: "a", score: 2 }, { id: "b", score: 3 }, { id: "c", score: 2 }], [{ id: "b", score: 3 }, { id: "a", score: 2 }, { id: "c", score: 2 }]), sample([], [])], "return [...value].sort((a, b) => b.score - a.score);"],
  ["J10", "阈值分组", "按threshold分为low和high，等于阈值进入high；保持各组顺序。", [sample({ items: [3, 1, 2], threshold: 2 }, { low: [1], high: [3, 2] }), sample({ items: [], threshold: 0 }, { low: [], high: [] })], "return {low: value.items.filter(x => x < value.threshold), high: value.items.filter(x => x >= value.threshold)};"],
  ["P01", "空白规范化", "去除首尾空白，将内部连续空白（含Tab）变成一个空格。", [sample("  rainy\t days ", "rainy days"), sample("", ""), sample("中文  文本", "中文 文本")], "return ' '.join(value.split())"],
  ["P02", "字典合并", "合并base与override；override优先，不修改两个输入字典。", [sample({ base: { a: 1, b: 2 }, override: { b: 3 } }, { a: 1, b: 3 }), sample({ base: {}, override: {} }, {})], "return {**value['base'], **value['override']}"],
  ["P03", "平均值", "返回列表平均值；空列表返回None，不把零当空值。", [sample([0, 2, 4], 2), sample([], null), sample([-2, 2], 0)], "return sum(value) / len(value) if value else None"],
  ["P04", "保序交集", "返回left中也在right里的元素，去重并保持left顺序。", [sample({ left: [3, 1, 3, 2], right: [2, 3] }, [3, 2]), sample({ left: [], right: [1] }, [])], "return list(dict.fromkeys(x for x in value['left'] if x in value['right']))"],
  ["P05", "最后扩展名", "返回文件名最后一个点后的扩展名，小写且不带点；无点或点文件返回空字符串。", [sample("REPORT.Final.CSV", "csv"), sample("README", ""), sample(".env", ""), sample("file.", "")], "return value.rsplit('.', 1)[1].lower() if '.' in value and not value.startswith('.') else ''"],
  ["P06", "展开一层", "把列表中的各个子列表按顺序展开一层，保留内部值。", [sample([[1, 2], [], [3]], [1, 2, 3]), sample([], []), sample([[null], [0]], [null, 0])], "return [item for group in value for item in group]"],
  ["P07", "嵌套键查找", "按path逐层查找字典；缺键或遇到非字典返回default，保留0与False。", [sample({ data: { a: { b: 0 } }, path: ["a", "b"], default: 9 }, 0), sample({ data: { a: 1 }, path: ["a", "b"], default: 9 }, 9)], "current = value['data']\n    for key in value['path']:\n        if not isinstance(current, dict) or key not in current:\n            return value['default']\n        current = current[key]\n    return current"],
  ["P08", "活跃记录筛选", "只保留active明确为True的记录，不把1或非空字符串当True。", [sample([{ id: 1, active: true }, { id: 2, active: 1 }, { id: 3, active: "yes" }, { id: 4, active: false }], [{ id: 1, active: true }]), sample([], [])], "return [item for item in value if item.get('active') is True]"],
  ["P09", "整数文本筛选", "从字符串列表提取整数，支持首尾空白与正负号，忽略无效文本、空串和小数。", [sample([" 3 ", "-2", "", "1.5", "no", "--2", "+4"], [3, -2, 4]), sample(["0", "-0"], [0, 0])], "result = []\n    for item in value:\n        try:\n            result.append(int(item.strip()))\n        except ValueError:\n            pass\n    return result"],
  ["P10", "CSV字段转义", "把字符串字段写成一条CSV记录，不保留末尾换行；逗号和引号须正确转义。", [sample(["a", "b,c", 'd"e'], 'a,"b,c","d""e"'), sample(["中文", "ok"], "中文,ok")], "import csv, io\n    output = io.StringIO()\n    csv.writer(output, lineterminator='\\n').writerow(value)\n    return output.getvalue().rstrip('\\n')"],
].map(([id, title, goal, samples, reference]) => ({ id, title, goal, samples, reference, language: id.startsWith("J") ? "javascript" : "python" }));

const args = process.argv.slice(2);
let requested = null, selfCheck = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--self-check" && !selfCheck) selfCheck = true;
  else if (args[index] === "--output" && requested === null) {
    requested = args[++index];
    if (!requested || !path.isAbsolute(requested)) throw new Error("--output requires an absolute, new directory");
  } else throw new Error("Usage: node scripts/prepare-coding-evaluation.mjs [--output ABSOLUTE_NEW_DIRECTORY] [--self-check]");
}
const root = requested ? path.resolve(requested) : await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-coding-evaluation-"));
if (requested) await fs.mkdir(root); // Never overwrite, merge with, or delete an existing directory.
const projects = path.join(root, "projects"), references = path.join(root, "evaluator-only");
await fs.mkdir(projects); await fs.mkdir(references);
const git = execFileSync(path.join(process.env.SystemRoot, "System32/where.exe"), ["git.exe"], { windowsHide: true, encoding: "utf8" }).split(/\r?\n/u).find(Boolean);
const results = [], manifest = [];
for (const item of cases) {
  const project = path.join(projects, item.id), referenceProject = path.join(references, item.id), js = item.language === "javascript";
  await fs.mkdir(project);
  const sourceName = js ? "logic.mjs" : "logic.py", source = js ? "export function solve(value) { return null; }\n" : "def solve(value):\n    return None\n";
  const solution = js ? `export function solve(value) { ${item.reference} }\n` : `def solve(value):\n    ${item.reference}\n`;
  const check = js ? "node --test" : "python -m unittest -q";
  await fs.writeFile(path.join(project, sourceName), source);
  await fs.writeFile(path.join(project, js ? "app.mjs" : "app.py"), js ? "import {solve} from './logic.mjs'; export const run = value => solve(value);\n" : "from logic import solve\ndef run(value):\n    return solve(value)\n");
  await fs.writeFile(path.join(project, js ? "logic.test.mjs" : "test_logic.py"), js
    ? `import test from 'node:test'; import assert from 'node:assert/strict'; import {run} from './app.mjs';\nconst samples=${JSON.stringify(item.samples)};\nfor(const [index,item] of samples.entries()) test('sample '+index,()=>{const before=structuredClone(item.input);assert.deepEqual(run(item.input),item.output);assert.deepEqual(item.input,before);});\n`
    : `import unittest, json, copy\nfrom app import run\nsamples = json.loads(${JSON.stringify(JSON.stringify(item.samples))})\nclass Cases(unittest.TestCase):\n    def test_samples(self):\n        for item in samples:\n            with self.subTest(item=item):\n                before=copy.deepcopy(item['input'])\n                self.assertEqual(run(item['input']), item['output'])\n                self.assertEqual(item['input'], before)\n`);
  await fs.writeFile(path.join(project, "README.md"), `# ${item.title}\n\n${item.goal}\n\n修复logic模块，使app入口返回正确结果。运行检查：${check}。保留已有注释与用户笔记，不修改测试、重置、提交或安装软件。\n`);
  await fs.writeFile(path.join(project, ".gitignore"), "__pycache__/\n");
  execFileSync(git, ["init", "-q"], { cwd: project, windowsHide: true });
  execFileSync(git, ["-c", "core.autocrlf=false", "add", "--", "."], { cwd: project, windowsHide: true });
  await fs.appendFile(path.join(project, sourceName), js ? "// USER_DIRTY_KEEP\n" : "# USER_DIRTY_KEEP\n");
  await fs.writeFile(path.join(project, "user-note.txt"), "USER_UNTRACKED_KEEP\n");
  await fs.mkdir(referenceProject);
  await fs.writeFile(path.join(referenceProject, sourceName), solution);
  const prompt = `在当前项目完成“${item.title}”：${item.goal} 先重现失败，保留用户已有改动与未跟踪文件，按项目说明运行真实检查。最多三次自动修正；给出差异、命令/退出码及未验证项，不修改测试或安装依赖。${["J05", "P05"].includes(item.id) ? "另运行rainydays_eval_missing_tool_8571 --version，区分缺依赖与项目测试结果，不宣称全部检查通过。" : ""}`;
  manifest.push({ id: item.id, language: item.language, title: item.title, project, prompt, check, timeoutSeconds: 300, maxRepairRounds: 3, baseline: "Git index contains original files; user comment is unstaged, user-note.txt untracked", status: "not-run" });
  if (selfCheck) {
    const executable = js ? process.execPath : "python.exe", commandArgs = js ? ["--test"] : ["-m", "unittest", "-q"];
    const red = spawnSync(executable, commandArgs, { cwd: project, windowsHide: true, encoding: "utf8", timeout: 10000 });
    for (const entry of await fs.readdir(project)) if (entry !== ".git" && entry !== sourceName && entry !== "__pycache__") await fs.copyFile(path.join(project, entry), path.join(referenceProject, entry));
    const green = spawnSync(executable, commandArgs, { cwd: referenceProject, windowsHide: true, encoding: "utf8", timeout: 10000 });
    const passed = red.status === 1 && green.status === 0;
    results.push({ id: item.id, passed, brokenExit: red.status, referenceExit: green.status, ...(passed ? {} : { diagnostic: (red.error?.message ?? "") + (green.error?.message ?? "") + green.stdout + green.stderr }) });
  }
}
await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({ version: 1, evidence: "Fixture preparation only; no model or product score", model: null, budget: null, authorizationRequired: true, cases: manifest }, null, 2) + "\n");
await fs.writeFile(path.join(root, "fixture-check.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ root, cases: manifest.length, selfCheck, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed), modelCalls: 0 }, null, 2));
if (results.some(item => !item.passed)) process.exitCode = 1;
