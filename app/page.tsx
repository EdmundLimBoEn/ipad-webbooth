export default function Home() {
  return (
    <main style={{ padding: 40, lineHeight: 1.6 }}>
      <h1>Photo Booth</h1>
      <p>Open a named event:</p>
      <ul>
        <li>
          Booth (take photos): <code>/your-event-name</code>
        </li>
        <li>
          Live gallery: <code>/your-event-name/live</code>
        </li>
      </ul>
    </main>
  );
}
