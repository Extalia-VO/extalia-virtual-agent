import { useMemo, type ReactNode } from 'react';
import { CopyButton } from '../ui/CopyButton';
import { useMessages } from '../ui/messages';
import { parseMarkdown, type Block, type Inline, type TableAlign } from './markdownParser';

export type WikilinkNode = Extract<Inline, { type: 'wikilink' }>;
/** Renders a wikilink (Knowledge notes). Without one, a wikilink shows as its text. */
export type WikilinkRenderer = (link: WikilinkNode, key: number) => ReactNode;

function renderInline(nodes: readonly Inline[], wikilink?: WikilinkRenderer): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text': return node.text;
      case 'break': return <br key={index} />;
      case 'code': return <code key={index}>{node.text}</code>;
      case 'strong': return <strong key={index}>{renderInline(node.children, wikilink)}</strong>;
      case 'em': return <em key={index}>{renderInline(node.children, wikilink)}</em>;
      case 'link': return <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">{renderInline(node.children, wikilink)}</a>;
      case 'wikilink': return wikilink ? wikilink(node, index) : (node.display ?? node.target);
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

/** Alignment is a class, so cells never carry inline styles. */
const alignClass = (align: TableAlign | undefined) => align ? `md-align-${align}` : undefined;

/** The wrapper scrolls sideways, so a wide table never stretches the chat or the page. */
function MarkdownTable({ block, wikilink }: { block: Extract<Block, { type: 'table' }>; wikilink?: WikilinkRenderer | undefined }) {
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>{block.header.map((cell, column) => <th key={column} scope="col" className={alignClass(block.align[column])}>{renderInline(cell, wikilink)}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, column) => <td key={column} className={alignClass(block.align[column])}>{renderInline(cell, wikilink)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderBlock(block: Block, index: number, wikilink?: WikilinkRenderer): ReactNode {
  switch (block.type) {
    case 'paragraph': return <p key={index}>{renderInline(block.children, wikilink)}</p>;
    case 'heading': {
      // Replies sit inside the page, so their headings start below the page's h1/h2.
      const Tag = (['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const)[block.level - 1]!;
      return <Tag key={index} className={`md-h${block.level}`}>{renderInline(block.children, wikilink)}</Tag>;
    }
    case 'list': {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, wikilink)}</li>);
      return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case 'quote': return <blockquote key={index}>{renderInline(block.children, wikilink)}</blockquote>;
    case 'code': return <CodeBlock key={index} block={block} />;
    case 'rule': return <hr key={index} />;
    case 'table': return <MarkdownTable key={index} block={block} wikilink={wikilink} />;
  }
}

/** With `wikilink`, `[[…]]` links are parsed (Knowledge notes) and drawn by it; chat replies leave it out. */
export function Markdown({ text, wikilink }: { text: string; wikilink?: WikilinkRenderer | undefined }) {
  const wikilinks = Boolean(wikilink);
  const blocks = useMemo(() => parseMarkdown(text, { wikilinks }), [text, wikilinks]);
  return <div className="markdown">{blocks.map((block, index) => renderBlock(block, index, wikilink))}</div>;
}
