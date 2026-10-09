import { useMemo, type ReactNode } from 'react';
import { CopyButton } from '../ui/CopyButton';
import { useMessages } from '../ui/messages';
import { parseMarkdown, type Block, type Inline } from './markdownParser';

function renderInline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text': return node.text;
      case 'break': return <br key={index} />;
      case 'code': return <code key={index}>{node.text}</code>;
      case 'strong': return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'em': return <em key={index}>{renderInline(node.children)}</em>;
      case 'link': return <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">{renderInline(node.children)}</a>;
    }
  });
}

function CodeBlock({ block }: { block: Extract<Block, { type: 'code' }> }) {
  const t = useMessages();
  const label = block.language ?? t.markdown.code;
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{label}</span>
        <CopyButton text={block.text} label={label} />
      </div>
      <pre tabIndex={0}><code>{block.text}</code></pre>
    </div>
  );
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case 'paragraph': return <p key={index}>{renderInline(block.children)}</p>;
    case 'heading': {
      // Replies sit inside the page, so their headings start below the page's h1/h2.
      const Tag = (['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const)[block.level - 1]!;
      return <Tag key={index} className={`md-h${block.level}`}>{renderInline(block.children)}</Tag>;
    }
    case 'list': {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>);
      return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case 'quote': return <blockquote key={index}>{renderInline(block.children)}</blockquote>;
    case 'code': return <CodeBlock key={index} block={block} />;
    case 'rule': return <hr key={index} />;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="markdown">{blocks.map(renderBlock)}</div>;
}
