import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

const assistantComponents = {
  p: ({ children }: any) => (
    <p className="text-sm leading-relaxed mb-2 last:mb-0">{children}</p>
  ),
  code: ({ className, children, ...props }: any) =>
    !className ? (
      <code className="bg-muted-foreground/15 px-1.5 py-0.5 rounded text-xs font-mono" {...props}>
        {children}
      </code>
    ) : (
      <code className={className} {...props}>{children}</code>
    ),
  pre: ({ children }: any) => (
    <pre className="bg-muted-foreground/10 rounded-lg p-3 overflow-x-auto my-2 text-xs">{children}</pre>
  ),
  ul: ({ children }: any) => <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>,
  li: ({ children }: any) => <li className="text-sm leading-relaxed">{children}</li>,
  h1: ({ children }: any) => <h1 className="text-lg font-semibold mt-3 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-base font-semibold mt-3 mb-2 first:mt-0">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 italic opacity-80">
      {children}
    </blockquote>
  ),
  a: ({ children, href }: any) => (
    <a href={href} className="underline hover:opacity-80" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
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
      <code className={className} {...props}>{children}</code>
    ),
  pre: ({ children }: any) => (
    <pre className="bg-black/20 rounded-lg p-3 overflow-x-auto my-2 text-xs">{children}</pre>
  ),
};

interface MarkdownContentProps {
  content: string;
  variant: "user" | "assistant";
}

export const MarkdownContent = memo(({ content, variant }: MarkdownContentProps) => (
  <ReactMarkdown
    rehypePlugins={[rehypeHighlight]}
    components={variant === "user" ? userComponents : assistantComponents}
  >
    {content}
  </ReactMarkdown>
));
MarkdownContent.displayName = "MarkdownContent";
