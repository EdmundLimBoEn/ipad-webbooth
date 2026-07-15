import EventLauncher from "./event-launcher";
import styles from "./home.module.css";

export default function Home() {
  return (
    <main className={styles.home}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Webbooth / event launcher</p>
        <h1>Give the night<br />a name.</h1>
        <p className={styles.intro}>
          Create a canonical event address, then open the booth, projector gallery,
          or darkroom console from one place.
        </p>
        <EventLauncher />
      </section>
      <aside className={styles.note} aria-label="Event naming guidance">
        <ol>
          <li><span>01</span><p><strong>Name</strong>Choose the canonical event slug.</p></li>
          <li><span>02</span><p><strong>Configure</strong>Pick frames and create an iPad key.</p></li>
          <li><span>03</span><p><strong>Test</strong>Take one photo before doors open.</p></li>
        </ol>
      </aside>
    </main>
  );
}
