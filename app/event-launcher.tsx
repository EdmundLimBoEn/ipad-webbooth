"use client";

import { FormEvent, useMemo, useState } from "react";
import { slugifyEvent } from "./event-identity";
import styles from "./home.module.css";

export default function EventLauncher() {
  const [name, setName] = useState("");
  const slug = useMemo(() => name.trim() ? slugifyEvent(name) : "", [name]);

  const launch = (path = "") => {
    if (!slug) return;
    window.location.assign(`/${slug}${path}`);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    launch();
  };

  return (
    <form className={styles.launcher} onSubmit={submit}>
      <label htmlFor="event-name">Event name</label>
      <div className={styles.inputRow}>
        <span aria-hidden="true">/</span>
        <input
          id="event-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="midnight-in-singapore"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
      </div>
      <p className={styles.canonical} aria-live="polite">
        {slug ? <>Canonical URL: <strong>/{slug}</strong></> : "Type a name to build its canonical URL."}
      </p>
      <div className={styles.launchActions}>
        <button className={styles.primary} disabled={!slug} type="submit">Open booth <span>↗</span></button>
        <button disabled={!slug} type="button" onClick={() => launch("/live")}>Live gallery</button>
        <button disabled={!slug} type="button" onClick={() => launch("/admin")}>Admin</button>
      </div>
    </form>
  );
}
