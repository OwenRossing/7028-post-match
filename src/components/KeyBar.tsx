/** Always-visible key hints for the current screen (hidden on touch screens). */
export function KeyBar({ keys, tabs = true, fixed = false }: { keys: [string, string][]; tabs?: boolean; fixed?: boolean }) {
  return (
    <div className={`keybar ${fixed ? 'keybar-fixed' : ''}`} aria-hidden="true">
      {keys.map(([k, label]) => (
        <span key={k}>
          {k.split(' ').map((x) => (
            <kbd key={x}>{x}</kbd>
          ))}
          {label}
        </span>
      ))}
      <span className="keybar-tabs">
        {tabs && (
          <>
            <kbd>1</kbd>–<kbd>5</kbd> tabs{' '}
          </>
        )}
        <kbd>?</kbd> all keys
      </span>
    </div>
  );
}
