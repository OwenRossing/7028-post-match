import { useState } from 'react';

/** Puts a text summary on the clipboard, to paste into a bug report instead of sending a file. If the browser refuses, shows it to copy by hand. */
export function CopyDiagnostics({
  build,
  label = 'Copy diagnostics',
  note = 'A short summary of how this log was read (numbers only, no messages), to paste when something looks wrong.',
}: {
  build: () => string;
  label?: string;
  note?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'show'>('idle');
  const [text, setText] = useState('');
  const copy = async () => {
    const t = build();
    setText(t);
    try {
      await navigator.clipboard.writeText(t);
      setState('copied');
      setTimeout(() => setState('idle'), 5000);
    } catch {
      setState('show'); // the browser refused: show it to copy by hand
    }
  };
  return (
    <div className="info-actions">
      <button className="btn small" onClick={copy}>
        {state === 'copied' ? 'Copied. Paste it in the chat.' : label}
      </button>
      <p className="muted info-empty">{note}</p>
      {state === 'show' && <textarea className="diag" readOnly rows={10} value={text} onFocus={(e) => e.currentTarget.select()} />}
    </div>
  );
}
