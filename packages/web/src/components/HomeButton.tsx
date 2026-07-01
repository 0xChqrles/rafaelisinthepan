// The logo doubles as the home control: it sits at the left of the HUD (beside the
// progress bar) and returns to the language picker. On desktop the Esc key does the
// same (see App); on mobile this is the primary way home — it never leaves the site,
// which matters when a shared puzzle link was opened as the first navigation.
export default function HomeButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="home-btn" onClick={onClick} aria-label="Home">
      <img className="home-logo" src="/logo.png" alt="" draggable="false" />
    </button>
  );
}
