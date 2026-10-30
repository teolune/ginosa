/** Media library. Importing, bins and previews arrive in M2; until then it says so plainly. */
export function MediaPanel() {
  return (
    <section className="panel media-panel">
      <header className="panel-header">
        <span>Media</span>
      </header>
      <div className="empty-state">
        <p>No media yet.</p>
        <p className="muted small">Importing video, audio and images arrives in M2.</p>
      </div>
    </section>
  )
}
