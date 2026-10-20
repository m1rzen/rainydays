export const wordBrief = {
  path: "季度经营简报.docx", title: "2026 年第三季度经营简报", paragraphs: [],
  blocks: [
    { kind: "heading", text: "摘要", level: 2 },
    { kind: "paragraph", text: "本季度销售额为 1,500 元，东部贡献 1,200 元，西部贡献 300 元。数据为研发验收使用的虚构样本。" },
    { kind: "heading", text: "关键事实", level: 2 },
    { kind: "table", headers: ["地区", "销售额（元）", "客户编号", "记录日期"], rows: [["东部", "1,200.00", "0007", "2026-10-01"], ["西部", "300.00", "0012", "2026-10-02"], ["合计", "1,500.00", "—", "—"]] },
    { kind: "heading", text: "后续行动", level: 2 },
    { kind: "bullet", text: "于 2026-11-25 前复核两地区原始明细。" },
    { kind: "bullet", text: "对比前先确认统计周期一致，再作结论。" },
    { kind: "paragraph", text: "资料依据：本次提供的虚构销售明细与汇总；未调用在线来源。" },
  ],
};

export const salesWorkbook = {
  path: "季度销售数据.xlsx",
  sheets: [
    { name: "季度汇总", data: [["地区", "销售额（元）", "客户编号", "记录日期", "完成率"], ["东部", 1200, "0007", "2026-10-01", 0.8], ["西部", 300, "0012", "2026-10-02", 0.6], ["合计", 1500, "", "", 0.75]], columnFormats: ["text", "decimal", "text", "date", "percent"] },
    { name: "销售明细", data: [["地区", "记录编号", "金额（元）"], ["东部", "E-01", 700], ["东部", "E-02", 500], ["西部", "W-01", 300]], columnFormats: ["text", "text", "decimal"] },
  ],
};
