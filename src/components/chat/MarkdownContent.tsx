import {
  memo,
  useEffect,
  useRef,
  useCallback,
  isValidElement,
  Children,
  createContext,
  useContext,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Copy, Check } from "lucide-react";
import lightCss from "highlight.js/styles/github.min.css?raw";
import darkCss from "highlight.js/styles/github-dark.min.css?raw";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTheme } from "../../hooks/useTheme";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useT } from "../../i18n";

const HLJS_STYLE_ID = "hljs-theme";
const MAX_MARKDOWN_DATA_IMAGE_BYTES = 1024 * 1024;
const SAFE_DATA_IMAGE_RE =
  /^data:image\/(?:png|jpe?g|gif|webp);base64,([a-zA-Z0-9+/=\s]+)$/i;
const MarkdownCodeBlockContext = createContext(false);

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-[\w-]+$/, /^hljs(?:\s|$)/],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", /^hljs-[\w-]+$/],
    ],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      ["src", /^https?:\/\//, /^data:image\/(?:png|jpe?g|gif|webp);base64,/i],
      "alt",
      "title",
    ],
  },
};

function estimateBase64Bytes(base64: string): number {
  const compact = base64.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

export function normalizeMarkdownHref(href: unknown): string | undefined {
  if (typeof href !== "string") return undefined;
  const trimmed = href.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    ) {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function normalizeMarkdownImageSrc(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  const trimmed = src.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString();
    } catch {
      return undefined;
    }
  }
  const match = SAFE_DATA_IMAGE_RE.exec(trimmed);
  if (!match) return undefined;
  if (estimateBase64Bytes(match[1]) > MAX_MARKDOWN_DATA_IMAGE_BYTES) {
    return undefined;
  }
  return trimmed;
}

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

function CodeBlockHeader({
  lang,
  preRef,
}: {
  lang: string;
  preRef: React.RefObject<HTMLPreElement | null>;
}) {
  const t = useT();
  const [copied, copy] = useCopyToClipboard();
  const copyLabel = copied ? t.message.copied : t.message.copy;

  const handleCopy = useCallback(() => {
    void copy(preRef.current?.textContent ?? "");
  }, [copy, preRef]);

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
      <span className="text-[11px] text-muted-foreground font-mono select-none">
        {(lang || "code").toUpperCase()}
      </span>
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copyLabel}
              className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="relative h-3.5 w-3.5" aria-hidden="true">
                <Copy
                  size={14}
                  className={`absolute inset-0 transition-[opacity,transform,color,background-color,border-color] duration-200 ${copied ? "opacity-0 scale-50" : "opacity-100 scale-100"}`}
                />
                <Check
                  size={14}
                  className={`absolute inset-0 transition-[opacity,transform,color,background-color,border-color] duration-200 ${copied ? "opacity-100 scale-100 text-green-500" : "opacity-0 scale-50"}`}
                />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{copyLabel}</TooltipContent>
        </Tooltip>
        <span className="sr-only" role="status" aria-live="polite">
          {copied ? t.message.copied : ""}
        </span>
      </div>
    </div>
  );
}

function AssistantMarkdownCode({
  className,
  children,
  node: _node,
  ...props
}: any) {
  const isBlock = useContext(MarkdownCodeBlockContext);
  return (
    <code
      className={
        isBlock
          ? className
          : "markdown-inline-code inline whitespace-normal align-baseline bg-muted-foreground/15 px-1.5 py-0.5 rounded text-xs font-mono"
      }
      {...props}
    >
      {children}
    </code>
  );
}

function UserMarkdownCode({ className, children, node: _node, ...props }: any) {
  const isBlock = useContext(MarkdownCodeBlockContext);
  return (
    <code
      className={
        isBlock
          ? className
          : "markdown-inline-code inline whitespace-normal align-baseline bg-primary-foreground/20 text-primary-foreground px-1.5 py-0.5 rounded text-xs font-mono"
      }
      {...props}
    >
      {children}
    </code>
  );
}

const assistantComponents = {
  p: ({ children }: any) => (
    <p className="text-sm leading-relaxed mb-2 last:mb-0">{children}</p>
  ),
  code: AssistantMarkdownCode,
  pre: ({ children }: any) => {
    const lang = extractLang(children);
    const preRef = useRef<HTMLPreElement>(null);
    return (
      <div className="rounded-lg overflow-hidden my-2 border border-border/40 bg-muted-foreground/10">
        <CodeBlockHeader lang={lang} preRef={preRef} />
        <MarkdownCodeBlockContext.Provider value={true}>
          <pre ref={preRef} className="p-3 overflow-x-auto text-xs">
            {children}
          </pre>
        </MarkdownCodeBlockContext.Provider>
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
  a: ({ children, href }: any) => {
    const safeHref = normalizeMarkdownHref(href);
    if (!safeHref) return <span>{children}</span>;
    return (
      <a
        href={safeHref}
        className="underline hover:opacity-80"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  strong: ({ children }: any) => (
    <strong className="font-semibold">{children}</strong>
  ),
  img: ({ src, alt }: any) => {
    const safeSrc = normalizeMarkdownImageSrc(src);
    if (!safeSrc) return null;
    return (
      <figure className="my-3">
        <img
          src={safeSrc}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="rounded-md max-w-full h-auto"
        />
        {alt && (
          <figcaption className="text-xs text-muted-foreground text-center mt-2">
            {alt}
          </figcaption>
        )}
      </figure>
    );
  },
};

const userComponents = {
  ...assistantComponents,
  code: UserMarkdownCode,
  pre: ({ children }: any) => {
    const lang = extractLang(children);
    const preRef = useRef<HTMLPreElement>(null);
    return (
      <div className="rounded-lg overflow-hidden my-2 border border-white/10 bg-black/20">
        <CodeBlockHeader lang={lang} preRef={preRef} />
        <MarkdownCodeBlockContext.Provider value={true}>
          <pre ref={preRef} className="p-3 overflow-x-auto text-xs">
            {children}
          </pre>
        </MarkdownCodeBlockContext.Provider>
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
        rehypePlugins={[
          rehypeHighlight,
          [rehypeSanitize, markdownSanitizeSchema],
        ]}
        components={variant === "user" ? userComponents : assistantComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  ),
);
MarkdownContent.displayName = "MarkdownContent";
