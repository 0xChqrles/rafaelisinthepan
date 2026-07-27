import type { ReactNode } from 'react';
import { t } from '../i18n';
import CloseIcon from '../assets/icons/close.svg?react';

// The header EVERY full-screen modal wears. It is not a modal chrome of its own: it is the
// APP's header row (TopBar), reused wholesale — `.topbar-inner`'s column and optical row, the
// screen's name in `.topbar-title` top-left, one `.home-btn` control top-right, and NO band,
// border, background or blur under either. So a modal cannot drift from the corner-chip policy,
// and the next one cannot re-invent it (extracted 2026-07-27 from the shape the route map had
// been carrying alone, while the leaderboard floated its own X in the corner).
//
// It sits IN FLOW above the modal's own scroller — which is precisely what lets it paint
// nothing: with the scroller (not the dialog) owning the overflow, no content can ever pass
// beneath the header, so none has to be hidden behind a band. A modal adopting this header
// therefore owes it that structure; the dialog itself must not scroll.
//
// The language flag is deliberately absent, which is the one place this row parts from the app
// header: switching language from inside a modal would navigate the screen out from under it.
export default function ModalHeader({
  lang,
  title,
  onClose,
  right,
}: {
  lang: string;
  // The surface's name, top-left. Optional — the app header leaves that corner empty too when
  // a screen has nothing to put there (the game floats its own counter into it instead).
  title?: ReactNode;
  onClose: () => void;
  // Extra controls, seated BEFORE the close so dismissal stays the last chip in the row.
  right?: ReactNode;
}) {
  return (
    <div className="modal-bar">
      <div className="topbar-inner">
        <div className="topbar-left">
          {title ? <span className="topbar-title">{title}</span> : null}
        </div>
        <div className="topbar-right">
          {right}
          <button
            type="button"
            className="home-btn modal-close"
            aria-label={t(lang, 'ariaClose')}
            onClick={onClose}
          >
            <CloseIcon className="pixel-icon" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
