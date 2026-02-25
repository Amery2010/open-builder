import { Folder, File } from "lucide-react";

type TreeNode = { [key: string]: TreeNode | null };

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = {};
  for (const p of paths) {
    const parts = p.trim().split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node[part] = null;
      } else {
        node[part] = (node[part] as TreeNode) || {};
        node = node[part] as TreeNode;
      }
    }
  }
  return root;
}

function sortEntries(entries: [string, TreeNode | null][]): [string, TreeNode | null][] {
  return entries.sort(([, a], [, b]) => {
    if (a !== null && b === null) return -1;
    if (a === null && b !== null) return 1;
    return 0;
  });
}

function TreeNodeRow({ name, node, depth }: { name: string; node: TreeNode | null; depth: number }) {
  const isDir = node !== null;
  return (
    <>
      <div className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: depth * 14 }}>
        {isDir
          ? <Folder size={12} className="text-yellow-500 shrink-0" />
          : <File size={12} className="text-muted-foreground shrink-0" />}
        <span className="text-xs font-mono text-foreground/80">{name}</span>
      </div>
      {isDir &&
        sortEntries(Object.entries(node!)).map(([childName, childNode]) => (
          <TreeNodeRow key={childName} name={childName} node={childNode} depth={depth + 1} />
        ))}
    </>
  );
}

interface FileTreeViewProps {
  content: string;
}

export function FileTreeView({ content }: FileTreeViewProps) {
  const paths = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "(empty)");

  if (paths.length === 0) {
    return <span className="text-xs text-muted-foreground">（空）</span>;
  }

  const tree = buildTree(paths);

  return (
    <div className="py-0.5">
      {sortEntries(Object.entries(tree)).map(([name, node]) => (
        <TreeNodeRow key={name} name={name} node={node} depth={0} />
      ))}
    </div>
  );
}
