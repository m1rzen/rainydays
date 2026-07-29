// ===========================================
// 知识图谱工具 —— inspect / graph / consolidate
// 将碎片叙事（memories）巩固为结构化实体和关系
// ===========================================

import type { ToolDefinition, ToolExecutor } from "../types.js";
import type { LLMClient } from "../llm.js";
import {
  upsertEntity,
  getEntity,
  getEntityByName,
  searchEntities,
  listEntities,
  insertEdge,
  getEdgesForEntity,
  listMemories,
  type EntityRow,
  type MemoryRow,
} from "../db.js";

// ===========================================
// inspect —— 展开实体详情
// ===========================================
export const inspectDef: ToolDefinition = {
  type: "function",
  function: {
    name: "inspect",
    description:
      "查看知识图谱中某个实体的详情，包括属性和所有关系。传入实体名称或 ID。用于深入了解某个项目、人物、概念等的关联信息。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "实体 ID" },
        name: { type: "string", description: "实体名称（和 id 二选一）" },
      },
    },
  },
};

export const inspectExec: ToolExecutor = async (args) => {
  let entity: EntityRow | undefined;
  const id = args.id as number | undefined;
  const name = args.name as string | undefined;

  if (id) {
    entity = getEntity(id);
  } else if (name) {
    entity = getEntityByName(name);
  }

  if (!entity) {
    return `未找到实体: ${id || name}`;
  }

  // 获取关系
  const edges = getEdgesForEntity(entity.id);

  let props: Record<string, unknown> = {};
  try { props = JSON.parse(entity.props || "{}"); } catch { /* ignore */ }

  let result = `实体: ${entity.name} (ID: ${entity.id})\n`;
  result += `类型: ${entity.kind}\n`;
  if (Object.keys(props).length > 0) {
    result += `属性:\n${Object.entries(props).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`;
  }
  result += `创建: ${entity.created_at}\n`;

  if (edges.length > 0) {
    result += `\n关系 (${edges.length}):\n`;
    for (const { edge, direction, other } of edges) {
      const arrow = direction === "out" ? "→" : "←";
      const otherSide = direction === "out" ? other.name : other.name;
      result += `  ${direction === "out" ? entity.name : other.name} --${edge.type}--> ${direction === "out" ? other.name : entity.name}\n`;
    }
  } else {
    result += `\n（暂无关系）\n`;
  }

  return result;
};

// ===========================================
// graph —— 展开关系子图
// ===========================================
export const graphDef: ToolDefinition = {
  type: "function",
  function: {
    name: "graph",
    description:
      "以某个实体为中心，展开 N 跳的关系子图。用于查看某个实体周围的关系网络。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "中心实体 ID" },
        name: { type: "string", description: "中心实体名称（和 id 二选一）" },
        depth: { type: "number", description: "展开深度（默认 1，最大 3）" },
      },
    },
  },
};

export const graphExec: ToolExecutor = async (args) => {
  let entity: EntityRow | undefined;
  const id = args.id as number | undefined;
  const name = args.name as string | undefined;
  const depth = Math.min((args.depth as number) || 1, 3);

  if (id) entity = getEntity(id);
  else if (name) entity = getEntityByName(name);

  if (!entity) {
    return `未找到实体: ${id || name}`;
  }

  // BFS 展开子图
  const visited = new Set<number>([entity.id]);
  const layers: { entity: EntityRow; edges: { type: string; other: EntityRow }[] }[] = [];
  let currentLayer = [entity.id];

  for (let d = 0; d < depth; d++) {
    const nextLayer: number[] = [];
    const layerData: { entity: EntityRow; edges: { type: string; other: EntityRow }[] }[] = [];

    for (const eid of currentLayer) {
      const ent = getEntity(eid);
      if (!ent) continue;

      const edges = getEdgesForEntity(eid);
      const relevantEdges: { type: string; other: EntityRow }[] = [];

      for (const { edge, other } of edges) {
        relevantEdges.push({ type: edge.type, other });
        if (!visited.has(other.id)) {
          visited.add(other.id);
          nextLayer.push(other.id);
        }
      }

      if (relevantEdges.length > 0) {
        layerData.push({ entity: ent, edges: relevantEdges });
      }
    }

    if (layerData.length > 0) layers.push(...layerData);
    currentLayer = nextLayer;
    if (currentLayer.length === 0) break;
  }

  let result = `关系子图: ${entity.name} (深度 ${depth})\n\n`;
  for (const { entity: ent, edges } of layers) {
    result += `${ent.name} (${ent.kind}):\n`;
    for (const { type, other } of edges) {
      result += `  --${type}--> ${other.name} (${other.kind})\n`;
    }
    result += "\n";
  }

  return result || `实体 ${entity.name} 没有关系。`;
};

// ===========================================
// consolidate —— 巩固：从记忆提取实体和关系
// ===========================================
export const consolidateDef: ToolDefinition = {
  type: "function",
  function: {
    name: "consolidate",
    description:
      "将最近的碎片记忆巩固为结构化知识。用 LLM 从记忆中提取实体和关系，存入知识图谱。提取后可以用 inspect 和 graph 查询。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "处理的记忆条数（默认 10）" },
      },
    },
  },
};

export function createConsolidateExec(llm: LLMClient): ToolExecutor {
  return async (args) => {
    const limit = (args.limit as number) || 10;
    const memories = listMemories(limit);

    if (memories.length === 0) {
      return "没有记忆可巩固。";
    }

    // 构造提取 prompt
    const memoryText = memories.map((m, i) => `[${i + 1}] (${m.kind}) ${m.content}`).join("\n");
    const extractPrompt = `从以下记忆中提取实体和关系。实体包括：人名、项目名、组织名、技术名、产品名等。关系包括：负责、参与、属于、使用、合作等。

记忆内容:
${memoryText}

请用以下 JSON 格式返回（只返回 JSON，不要其他文字）:
{
  "entities": [
    {"name": "实体名", "kind": "person/project/org/tech/product/concept"}
  ],
  "edges": [
    {"src": "源实体名", "dst": "目标实体名", "type": "关系类型"}
  ]
}

注意：
1. 实体名要准确、简洁
2. 关系类型用动词（如 "负责"、"参与"、"属于"）
3. 只提取明确出现在记忆中的信息，不要猜测`;

    try {
      const response = await llm.chat([
        { role: "system", content: "你是信息提取器。从非结构化文本中提取实体和关系，返回 JSON。" },
        { role: "user", content: extractPrompt },
      ]);

      // 解析 JSON
      let jsonStr = response.content.trim();
      // 去掉可能的 markdown 代码块标记
      jsonStr = jsonStr.replace(/^```json\s*/, "").replace(/```\s*$/, "");
      const data = JSON.parse(jsonStr);

      const entityMap = new Map<string, number>();
      let entityCount = 0;
      let edgeCount = 0;

      // 插入实体
      for (const ent of data.entities || []) {
        const id = upsertEntity(ent.name, ent.kind || "thing");
        entityMap.set(ent.name, id);
        entityCount++;
      }

      // 插入关系
      for (const edge of data.edges || []) {
        const srcId = entityMap.get(edge.src);
        const dstId = entityMap.get(edge.dst);
        if (srcId && dstId) {
          insertEdge(srcId, dstId, edge.type);
          edgeCount++;
        }
      }

      return `✅ 巩固完成: 提取了 ${entityCount} 个实体, ${edgeCount} 条关系。用 inspect 或 graph 工具查看。`;
    } catch (err) {
      return `巩固失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
