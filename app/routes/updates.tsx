import type { MetaFunction } from "react-router";

import { PublicPage, publicStyles as styles } from "../components/PublicPage";
import { UPCOMING, UPDATES } from "../lib/site-content";

export const meta: MetaFunction = () => [{ title: "Updates · SKU Doctor" }];

const formatDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

export default function Updates() {
  return (
    <PublicPage title="Updates" intro="What's new in SKU Doctor.">
      {UPCOMING.length > 0 && (
        <article className={styles.card}>
          <div className={styles.meta}>Coming soon</div>
          {UPCOMING.map((u) => (
            <div key={u.title}>
              <h2>{u.title}</h2>
              <p>{u.description}</p>
            </div>
          ))}
        </article>
      )}
      {UPDATES.map((u) => (
        <article key={u.date + u.title} className={styles.card}>
          <div className={styles.meta}>{formatDate(u.date)}</div>
          <h2>{u.title}</h2>
          <ul>
            {u.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      ))}
    </PublicPage>
  );
}
