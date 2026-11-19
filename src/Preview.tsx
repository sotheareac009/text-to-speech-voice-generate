/**
 * One picture, big.
 *
 * A scene thumbnail is 104px wide — enough to see that a picture is roughly
 * right, not enough to see that a hand has six fingers or that the light is
 * wrong. Deciding whether to redraw means looking at it properly, so a click
 * opens it at the size of the window.
 */

import { useEffect } from "react";

export function Preview({
  src,
  caption,
  onClose,
}: {
  src: string;
  caption?: string;
  onClose: () => void;
}) {
  // Escape closes it, as it does everywhere else. The listener is on the
  // window because the overlay is not what has focus after a click on a
  // thumbnail deeper in the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="preview" onClick={onClose} role="presentation">
      <figure onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={caption ?? ""} />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      <button className="preview-close" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}
