import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "../helpers.mjs";

// 会议文稿语义标注样本（2026-11-14 审阅补充切片5，沿 A11/D07/D08，服务 A13 基准集）：
// 六个语义维度各设正反例，独立于真实模型评测；分项评分维度（事实保真/语言表达/版式）
// 权重合计为 1。本测试只校验数据集的完整性、一致性与引用有效性，不做真实模型调用
// （真实评测在 A04/A13 授权后进行）。

const dataset = JSON.parse(await readFile(path.join(projectRoot, "tests", "fixtures", "semantic-samples.json"), "utf8"));

test("语义样本数据集：六维度各至少两条正例与两条反例，标注字段完整", () => {
  const requiredDimensions = ["amount_bounds", "statistic_subject", "inclusion", "risk_dimension", "commitment_level", "unsupported_enforcement"];
  const declared = new Set(dataset.dimensions.map(dimension => dimension.id));
  for (const id of requiredDimensions) assert(declared.has(id), `缺少语义维度: ${id}`);
  const ids = new Set();
  const texts = new Set();
  for (const dimension of dataset.dimensions) {
    assert(typeof dimension.name === "string" && dimension.name.length > 0, `${dimension.id} 缺少名称`);
    assert(typeof dimension.description === "string" && dimension.description.length > 0, `${dimension.id} 缺少说明`);
  }
  for (const sample of dataset.samples) {
    assert(!ids.has(sample.id), `样本 id 重复: ${sample.id}`);
    assert(!texts.has(sample.text), `样本 text 重复: ${sample.id}`);
    ids.add(sample.id);
    texts.add(sample.text);
    assert(declared.has(sample.dimension), `样本 ${sample.id} 引用了未声明的维度 ${sample.dimension}`);
    assert(["positive", "negative"].includes(sample.label), `样本 ${sample.id} label 非法`);
    assert(typeof sample.text === "string" && sample.text.length > 0, `样本 ${sample.id} 缺少 text`);
    assert(typeof sample.rationale === "string" && sample.rationale.length > 0, `样本 ${sample.id} 缺少标注依据`);
  }
  for (const id of requiredDimensions) {
    const positive = dataset.samples.filter(sample => sample.dimension === id && sample.label === "positive");
    const negative = dataset.samples.filter(sample => sample.dimension === id && sample.label === "negative");
    assert(positive.length >= 2, `维度 ${id} 正例不足 2 条`);
    assert(negative.length >= 2, `维度 ${id} 反例不足 2 条`);
  }
});

test("分项评分维度：事实保真/语言表达/版式，权重合计为 1", () => {
  const scoring = dataset.scoringDimensions;
  assert.deepEqual(scoring.map(dimension => dimension.id), ["factuality", "language", "layout"]);
  const weight = scoring.reduce((sum, dimension) => sum + dimension.weight, 0);
  assert.ok(Math.abs(weight - 1) < 1e-9, `评分权重合计应为 1，实际 ${weight}`);
  for (const dimension of scoring) {
    assert(typeof dimension.description === "string" && dimension.description.length > 0, `评分维度 ${dimension.id} 缺少说明`);
  }
});

test("篇幅规则：默认纪要不设最低页数，扩写仅限本次明确约定", async () => {
  const skill = await readFile(path.join(projectRoot, "skills", "meeting-minutes.md"), "utf8");
  assert.match(skill, /不设最低页数/u, "模板明确默认不设最低页数");
  assert.match(skill, /明确约定[^\n]*详版\/两页以上\/完整版/u, "扩写仅适用于本次明确约定");
  assert.match(skill, /不得为凑篇幅重复或泛化/u, "扩写不得凑篇幅");
  assert.match(skill, /截图阅读宽度/u, "版式规则覆盖截图阅读宽度");
});
