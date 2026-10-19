import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

import { PublicPage, publicStyles as styles } from "../components/PublicPage";
import { supportEmail } from "../lib/site-content";

export const meta: MetaFunction = () => [{ title: "Privacy policy · SKU Doctor" }];

export const loader = () => ({ email: supportEmail() });

export default function Privacy() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <PublicPage title="Privacy policy" intro="Last updated October 19, 2026">
      <section className={styles.card}>
        <h2>What SKU Doctor accesses</h2>
        <p>
          SKU Doctor reads your store’s products and inventory items (titles,
          SKUs, barcodes, prices, costs, weights, inventory quantities, tags,
          vendors and product images) to audit your catalog and build line
          sheets. It changes products only when you choose to: when you use
          Fix in Shopify, or turn on a scheduled sync that fixes values, it
          sets the weights, costs or barcodes you selected from your warehouse
          system, and keeps the old values so you can undo the change. It does
          not access customer or order information.
        </p>
      </section>

      <section className={styles.card}>
        <h2>What we store</h2>
        <ul>
          <li>Your store’s address and the access token Shopify issues to the app.</li>
          <li>The latest snapshot of your catalog, so pages load quickly.</li>
          <li>
            If you connect a warehouse system such as ShipHero: its API
            credentials, encrypted, and the results of your comparisons.
          </li>
          <li>
            If you use Fix in Shopify or scheduled sync: each changed value and
            the value it replaced, and a log of comparison and sync runs (kept
            for 90 days so changes can be undone), and your schedule settings.
          </li>
        </ul>
        <p>
          Data is stored in a managed Postgres database hosted by Netlify and
          is used only to provide SKU Doctor’s features. We don’t sell or share
          it, and we don’t use it for advertising.
        </p>
      </section>

      <section className={styles.card}>
        <h2>Warehouse systems</h2>
        <p>
          When you run a warehouse comparison, SKU Doctor sends your SKUs to
          the warehouse system you connected (for example ShipHero) to look up
          their weights, costs and barcodes.
        </p>
      </section>

      <section className={styles.card}>
        <h2>Deleting your data</h2>
        <p>
          Uninstalling SKU Doctor deletes everything it stored for your store.
          SKU Doctor also honors Shopify’s privacy requests: it holds no
          customer data, and a shop data deletion request removes anything left
          for your store.
        </p>
      </section>

      <section className={styles.card}>
        <h2>Contact</h2>
        <p>
          {email ? (
            <>
              Questions about privacy? Email <a href={`mailto:${email}`}>{email}</a>.
            </>
          ) : (
            "Questions about privacy? Contact us through the SKU Doctor support page."
          )}
        </p>
      </section>
    </PublicPage>
  );
}
