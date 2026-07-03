import Button from './Button';

// Shared error+retry surface for a failed load — the day's puzzle (App) or the
// language vocabulary (Game). Both use it so the two failures look and behave the
// same (issue #14): a transient/unexpected failure shows the message plus a RETRY
// that re-runs the fetch, so an error never dead-ends in a blank / infinite LOADING…
// screen. (A 404 "NO PUZZLE TODAY" is NOT an error — it stays a plain status, no retry.)
export default function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="load-error">
      <p className="status error">{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        RETRY
      </Button>
    </div>
  );
}
