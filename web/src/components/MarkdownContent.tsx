import { type InlineNode, parseMarkdown } from '../lib/llm';

function renderInlines(inlines: readonly InlineNode[]) {
  return inlines.map((node, idx) => {
    switch (node.type) {
      case 'bold':
        return (
          <strong key={idx} className="font-semibold text-slate-100">
            {node.text}
          </strong>
        );
      case 'italic':
        return (
          <em key={idx} className="italic text-slate-200">
            {node.text}
          </em>
        );
      case 'code':
        return (
          <code
            key={idx}
            className="px-1 py-0.5 rounded bg-slate-800 text-sky-300 font-mono text-[0.85em]"
          >
            {node.text}
          </code>
        );
      default:
        return <span key={idx}>{node.text}</span>;
    }
  });
}

export function MarkdownContent({ text }: { text: string }) {
  const blocks = parseMarkdown(text);

  return (
    <div className="space-y-2.5 text-sm text-slate-200 leading-relaxed break-words">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'heading': {
            const cls =
              block.level === 1
                ? 'text-base font-bold text-sky-300 pt-1'
                : block.level === 2
                  ? 'text-sm font-bold text-sky-300 pt-1'
                  : 'text-xs font-bold uppercase tracking-wide text-slate-300 pt-1';
            return (
              <div key={idx} className={cls}>
                {renderInlines(block.inlines)}
              </div>
            );
          }
          case 'ul':
            return (
              <ul key={idx} className="list-disc pl-5 space-y-1.5 text-slate-200">
                {block.items.map((item, i) => (
                  <li key={i}>{renderInlines(item)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={idx} className="list-decimal pl-5 space-y-1.5 text-slate-200">
                {block.items.map((item, i) => (
                  <li key={i}>{renderInlines(item)}</li>
                ))}
              </ol>
            );
          case 'blockquote':
            return (
              <blockquote
                key={idx}
                className="border-l-2 border-sky-400/60 pl-3 text-slate-300 italic"
              >
                {renderInlines(block.inlines)}
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={idx}
                className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-200 overflow-x-auto whitespace-pre-wrap"
              >
                {block.text}
              </pre>
            );
          default:
            return <p key={idx}>{renderInlines(block.inlines)}</p>;
        }
      })}
    </div>
  );
}
