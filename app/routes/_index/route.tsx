import type { LoaderFunctionArgs } from "react-router";
import { redirect, Link } from "react-router";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Anything coming from the Shopify admin goes straight into the app.
  if (params.get("shop") || params.get("host") || params.get("embedded")) {
    throw redirect(`/app?${params.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <img className={styles.logo} src="/logo.svg" alt="" width={96} height={96} />
        <h1 className={styles.heading}>SKU Doctor</h1>
        <p className={styles.text}>
          Find and fix catalog problems before they cost you money, and build
          wholesale line sheets in minutes.
        </p>
        {/* Merchants install and open the app from Shopify, never by typing
            their store's address here (App Store requirement). */}
        <p className={styles.text}>
          Install SKU Doctor from the Shopify App Store, then open it from Apps
          in your Shopify admin.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Catalog audit</strong>
            <span>
              Flags prices below cost, missing weights, duplicate SKUs, thin
              margins and more across every variant.
            </span>
          </li>
          <li>
            <strong>Warehouse comparison</strong>
            <span>
              Checks weights, costs and barcodes against ShipHero, Veeqo or
              Cin7 Core.
            </span>
          </li>
          <li>
            <strong>Wholesale line sheets</strong>
            <span>
              Pick products, set wholesale pricing and get a print-ready PDF
              or spreadsheet.
            </span>
          </li>
        </ul>
        <nav className={styles.links}>
          <Link to="/updates">Updates</Link>
          <Link to="/support">Support</Link>
          <Link to="/privacy">Privacy</Link>
        </nav>
      </div>
    </div>
  );
}
