import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

import { PublicPage, publicStyles as styles } from "../components/PublicPage";
import { FAQ, supportEmail } from "../lib/site-content";

export const meta: MetaFunction = () => [{ title: "Support · SKU Doctor" }];

export const loader = () => ({ email: supportEmail() });

export default function Support() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <PublicPage
      title="Support"
      intro="Questions, problems or ideas for SKU Doctor? We're happy to help."
    >
      <section className={styles.card}>
        <h2>Contact us</h2>
        {email ? (
          <>
            <p>
              Email <a href={`mailto:${email}`}>{email}</a> with your store’s
              myshopify.com address and a short description, and we’ll get back
              to you as soon as we can.
            </p>
            <a className={styles.button} href={`mailto:${email}?subject=SKU%20Doctor%20support`}>
              Email support
            </a>
          </>
        ) : (
          <p>Our support address is being set up. Please check back shortly.</p>
        )}
      </section>

      <section className={styles.card}>
        <h2>Frequently asked questions</h2>
        {FAQ.map((f) => (
          <div key={f.question}>
            <h3>{f.question}</h3>
            <p>{f.answer}</p>
          </div>
        ))}
      </section>
    </PublicPage>
  );
}
