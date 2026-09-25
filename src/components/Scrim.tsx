import { createPortal } from 'react-dom';

/**
 * Click-away layer behind an open menu. Rendered on <body>: inside the top bar,
 * its backdrop-filter would shrink a fixed overlay to the bar itself.
 */
export function Scrim({ onClose }: { onClose: () => void }) {
  return createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={onClose} />, document.body);
}
