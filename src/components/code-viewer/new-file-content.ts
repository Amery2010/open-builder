export function getNewFileInitialContent(path: string): string {
  const fileName = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (fileName?.endsWith(".json")) return "{}\n";
  if (fileName?.endsWith(".tsx") || fileName?.endsWith(".jsx")) {
    return "export default function NewComponent() {\n  return <div />;\n}\n";
  }
  return "// New file\n";
}
