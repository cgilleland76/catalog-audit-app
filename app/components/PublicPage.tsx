import type { ReactNode } from "react";
import { Link } from "react-router";

import styles from "./public.module.css";

/** Shell for the public pages: logo header, content column and footer links. */
export function PublicPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <img src="/logo.svg" alt="" width={32} height={32} />
          SKU Doctor
        </Link>
        <nav className={styles.nav}>
          <Link to="/updates">Updates</Link>
          <Link to="/support">Support</Link>
          <Link to="/privacy">Privacy</Link>
        </nav>
      </header>
      <main className={styles.main}>
        <h1 className={styles.title}>{title}</h1>
        {intro && <p className={styles.intro}>{intro}</p>}
        {children}
      </main>
      <footer className={styles.footer}>
        © {new Date().getFullYear()} SKU Doctor
      </footer>
    </div>
  );
}

export { styles as publicStyles };
