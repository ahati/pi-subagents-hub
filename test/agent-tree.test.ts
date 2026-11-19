import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { agentTree, buildAgentHierarchy } from "../src/ui/agent-tree.js";

const rec = (id: string, startedAt: number, parentAgentId?: string): AgentRecord =>
  ({ id, startedAt, parentAgentId }) as AgentRecord;

const layout = (records: AgentRecord[]) => agentTree(records).map(r => `${r.prefix}${r.record.id}`);

describe("agentTree", () => {
  it("keeps top-level order as given and lists children under their parent, earliest first", () => {
    // Newest-first top level, as `/agents` passes it; children out of order.
    expect(layout([
      rec("b", 20),
      rec("b-late", 40, "b"),
      rec("a", 10),
      rec("b-early", 30, "b"),
    ])).toEqual([
      "b",
      "├ b-early",
      "└ b-late",
      "a",
    ]);
  });

  it("continues a rail under `├` and blank under `└` for grandchildren", () => {
    expect(layout([
      rec("p", 0),
      rec("c1", 1, "p"),
      rec("g1", 2, "c1"),
      rec("c2", 3, "p"),
      rec("g2", 4, "c2"),
    ])).toEqual([
      "p",
      "├ c1",
      "│ └ g1",
      "└ c2",
      "  └ g2",
    ]);
  });

  it("drops a child whose parent is not in the list", () => {
    expect(layout([rec("p", 0), rec("orphan", 1, "gone")])).toEqual(["p"]);
  });
});

describe("buildAgentHierarchy", () => {
  it("builds multi-depth hierarchy with accurate depth, isLastChild, and childCount", () => {
    const records = [
      rec("root", 10),
      rec("c1", 20, "root"),
      rec("c2", 30, "root"),
      rec("g1", 40, "c1"),
    ];

    const nodes = buildAgentHierarchy(records);
    expect(nodes.map(n => ({ id: n.record.id, depth: n.depth, isLastChild: n.isLastChild, childCount: n.childCount }))).toEqual([
      { id: "root", depth: 0, isLastChild: undefined, childCount: 2 },
      { id: "c1", depth: 1, isLastChild: false, childCount: 1 },
      { id: "g1", depth: 2, isLastChild: true, childCount: 0 },
      { id: "c2", depth: 1, isLastChild: true, childCount: 0 },
    ]);
  });

  it("supports sortRoots: true", () => {
    const records = [rec("late", 50), rec("early", 10)];
    const nodes = buildAgentHierarchy(records, { sortRoots: true });
    expect(nodes.map(n => n.record.id)).toEqual(["early", "late"]);
  });

  it("respects maxDepth cap and tracks childCount beyond the cap", () => {
    const records = [
      rec("root", 10),
      rec("c1", 20, "root"),
      rec("g1", 30, "c1"),
      rec("g2", 40, "c1"),
    ];

    const nodes = buildAgentHierarchy(records, { maxDepth: 1 });
    expect(nodes.map(n => ({ id: n.record.id, depth: n.depth, childCount: n.childCount }))).toEqual([
      { id: "root", depth: 0, childCount: 1 },
      { id: "c1", depth: 1, childCount: 2 },
    ]);
  });

  it("supports explicit roots and links parentRecord", () => {
    const records = [
      rec("root", 10),
      rec("c1", 20, "root"),
      rec("c2", 30, "root"),
    ];

    const nodes = buildAgentHierarchy(records, { roots: [records[1]] });
    expect(nodes[0].parentRecord?.id).toBe("root");
  });
});
