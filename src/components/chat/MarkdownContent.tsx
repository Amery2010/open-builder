import {
  memo,
  useEffect,
  useRef,
  useState,
  useCallback,
  isValidElement,
  Children,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Copy, Check } from "lucide-react";
import lightCss from "highlight.js/styles/github.min.css?raw";
import darkCss from "highlight.js/styles/github-dark.min.css?raw";
import { useTheme } from "../../hooks/useTheme";

const HLJS_STYLE_ID = "hljs-theme";

function HljsTheme() {
  const isDark = useTheme();

  useEffect(() => {
    let el = document.getElementById(HLJS_STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = HLJS_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = isDark ? darkCss : lightCss;
  }, [isDark]);

  return null;
}

/** Extract language name from code element's className (e.g. "language-tsx hljs" → "tsx") */
function extractLang(children: React.ReactNode): string {
  const child = Children.toArray(children)[0];
  if (
    isValidElement<{ className?: string }>(child) &&
    typeof child.props?.className === "string"
  ) {
    const match = /language-(\w+)/.exec(child.props.className);
    if (match) return match[1];
  }
  return "";
}

/** Extract plain text from React children tree for clipboard copy */
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: React.ReactNode }>(node))
    return extractText(node.props?.children);
  return "";
}

function CodeBlockHeader({
  lang,
  preRef,
}: {
  lang: string;
  preRef: React.RefObject<HTMLPreElement | null>;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [preRef]);

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
      <span className="text-[11px] text-muted-foreground font-mono select-none">
        {(lang || "code").toUpperCase()}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span className="relative w-3.5 h-3.5">
          <Copy
            size={14}
            className={`absolute inset-0 transition-all duration-200 ${copied ? "opacity-0 scale-50" : "opacity-100 scale-100"}`}
          />
          <Check
            size={14}
            className={`absolute inset-0 transition-all duration-200 ${copied ? "opacity-100 scale-100 text-green-500" : "opacity-0 scale-50"}`}
          />
        </span>
      </button>
    </div>
  );
}

const assistantComponents = {
  p: ({ children }: any) => (
    <p className="text-sm leading-relaxed mb-2 last:mb-0">{children}</p>
  ),
  code: ({ className, children, ...props }: any) =>
    !className ? (
      <code
        className="bg-muted-foreground/15 px-1.5 py-0.5 rounded text-xs font-mono"
        {...props}
      >
        {children}
      </code>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    ),
  pre: ({ children }: any) => {
    const lang = extractLang(children);
    const preRef = useRef<HTMLPreElement>(null);
    return (
      <div className="rounded-lg overflow-hidden my-2 border border-border/40 bg-muted-foreground/10">
        <CodeBlockHeader lang={lang} preRef={preRef} />
        <pre ref={preRef} className="p-3 overflow-x-auto text-xs">
          {children}
        </pre>
      </div>
    );
  },
  ul: ({ children, className }: any) =>
    className?.includes("contains-task-list") ? (
      <ul className="my-2 space-y-1">{children}</ul>
    ) : (
      <ul className="list-disc pl-4.5 my-2 space-y-1">{children}</ul>
    ),
  ol: ({ children }: any) => (
    <ol className="list-decimal pl-4.5 my-2 space-y-1">{children}</ol>
  ),
  li: ({ children, className }: any) =>
    className?.includes("task-list-item") ? (
      <li className="flex items-center gap-2 text-sm leading-relaxed list-none">
        {children}
      </li>
    ) : (
      <li className="text-sm leading-relaxed pl-1">{children}</li>
    ),
  input: ({ type, checked }: any) =>
    type === "checkbox" ? (
      <span
        className={`mt-0.5 shrink-0 inline-flex w-3.5 h-3.5 rounded-sm border items-center justify-center transition-colors ${
          checked
            ? "bg-primary border-primary"
            : "border-muted-foreground/40 bg-transparent"
        }`}
      >
        {checked && (
          <Check size={9} strokeWidth={3} className="text-primary-foreground" />
        )}
      </span>
    ) : null,
  h1: ({ children }: any) => (
    <h1 className="text-lg font-semibold mt-3 mb-2 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-base font-semibold mt-3 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>
  ),
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 italic opacity-80">
      {children}
    </blockquote>
  ),
  a: ({ children, href }: any) => (
    <a
      href={href}
      className="underline hover:opacity-80"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  strong: ({ children }: any) => (
    <strong className="font-semibold">{children}</strong>
  ),
};

const userComponents = {
  ...assistantComponents,
  code: ({ className, children, ...props }: any) =>
    !className ? (
      <code
        className="bg-primary-foreground/20 text-primary-foreground px-1.5 py-0.5 rounded text-xs font-mono"
        {...props}
      >
        {children}
      </code>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    ),
  pre: ({ children }: any) => {
    const lang = extractLang(children);
    const preRef = useRef<HTMLPreElement>(null);
    return (
      <div className="rounded-lg overflow-hidden my-2 border border-white/10 bg-black/20">
        <CodeBlockHeader lang={lang} preRef={preRef} />
        <pre ref={preRef} className="p-3 overflow-x-auto text-xs">
          {children}
        </pre>
      </div>
    );
  },
};

interface MarkdownContentProps {
  content: string;
  variant: "user" | "assistant";
}

export const MarkdownContent = memo(
  ({ content, variant }: MarkdownContentProps) => (
    <div className="markdown-content">
      <HljsTheme />
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={variant === "user" ? userComponents : assistantComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  ),
);
MarkdownContent.displayName = "MarkdownContent";
